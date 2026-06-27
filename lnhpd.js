// ── State ──────────────────────────────────────────────────────────────────
let allProducts      = [];   // full deduplicated list of {lnhpd_id, route_type_desc}
let enrichedCache    = {};   // lnhpd_id → enriched product object (cached after first fetch)
let licenceNumberMap = {};   // lnhpd_id → licence_number (built at startup)
let filteredIds      = [];   // lnhpd_ids after filtering
let currentPage      = 1;
const PAGE_SIZE      = 25;
let sortKey          = 'licence_number';
let sortDir          = 'desc';

// Tracks which lnhpd_ids have been enriched so we can filter on them
let enrichedResults  = [];   // array of enriched objects for the current filtered set

// ── Column definitions ──────────────────────────────────────────────────────
const COLUMNS = [
    { key: 'licence_number',      label: 'Licence #',         cls: 'col-licence', modal: true },
    { key: 'product_name',        label: 'Product name',      cls: 'col-brand' },
    { key: 'company_name',        label: 'Company' },
    { key: 'dosage_form',         label: 'Dosage form' },
    { key: 'route_type_desc',     label: 'Route' },
    { key: 'licence_date',        label: 'Licence date',      cls: 'col-date' },
    { key: 'flag_product_status', label: 'Status',            cls: 'col-status' },
];

// ── Fetch helpers ───────────────────────────────────────────────────────────
const BASE = 'https://health-products.canada.ca/api/natural-licences';

async function fetchData(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
    return res.json();
}

// Fetch a single product licence by lnhpd_id and cache it.
// IMPORTANT: productlicence ?id= expects licence_number (not lnhpd_id).
// All other endpoints use lnhpd_id for ?id=.
async function fetchLicence(lnhpdId) {
    if (enrichedCache[lnhpdId]) return enrichedCache[lnhpdId];
    try {
        const licenceNumber = licenceNumberMap[lnhpdId];
        if (!licenceNumber) throw new Error(`No licence_number found for lnhpd_id ${lnhpdId}`);

        const data    = await fetchData(`${BASE}/productlicence/?id=${licenceNumber}&lang=en&type=json`);
        const licence = Array.isArray(data) ? data[0] : data;
        const route   = allProducts.find(p => p.lnhpd_id === lnhpdId);
        const enriched = {
            lnhpd_id:            lnhpdId,
            licence_number:      licence?.licence_number                              || licenceNumber,
            product_name:        licence?.product_name                                || '—',
            company_name:        licence?.company_name                                || '—',
            dosage_form:         licence?.dosage_form                                 || '—',
            licence_date:        licence?.licence_date                                || '—',
            flag_product_status: licence?.flag_product_status != null
                                     ? (licence.flag_product_status === 1 ? 'Active' : 'Inactive')
                                     : '—',
            route_type_desc:     route?.route_type_desc                               || '—',
            _raw:                licence,
        };
        enrichedCache[lnhpdId] = enriched;
        return enriched;
    } catch {
        return {
            lnhpd_id:            lnhpdId,
            licence_number:      licenceNumberMap[lnhpdId] || '—',
            product_name:        '—',
            company_name:        '—',
            dosage_form:         '—',
            licence_date:        '—',
            flag_product_status: '—',
            route_type_desc:     allProducts.find(p => p.lnhpd_id === lnhpdId)?.route_type_desc || '—',
            _raw:                null,
        };
    }
}

// ── Data loading ─────────────────────────────────────────────────────────────

// Build lnhpd_id → licence_number map by paginating through productlicence.
// productlicence without ?id= returns all licences paginated.
// Each record contains both lnhpd_id and licence_number.
async function buildLicenceNumberMap() {
    const firstPage = await fetchData(`${BASE}/productlicence/?lang=en&type=json`);
    const records   = firstPage?.data || (Array.isArray(firstPage) ? firstPage : []);
    records.forEach(r => {
        if (r.lnhpd_id && r.licence_number) licenceNumberMap[r.lnhpd_id] = r.licence_number;
    });

    // Fetch remaining pages in parallel if paginated
    const pagination = firstPage?.metadata?.pagination;
    if (pagination && pagination.total && pagination.limit) {
        const totalPages = Math.ceil(pagination.total / pagination.limit);
        const pagePromises = [];
        for (let p = 2; p <= totalPages; p++) {
            pagePromises.push(
                fetchData(`${BASE}/productlicence/?lang=en&type=json&page=${p}`)
                    .then(d => {
                        const rows = d?.data || (Array.isArray(d) ? d : []);
                        rows.forEach(r => {
                            if (r.lnhpd_id && r.licence_number) {
                                licenceNumberMap[r.lnhpd_id] = r.licence_number;
                            }
                        });
                    })
                    .catch(() => {})
            );
        }
        // Batch page fetches to avoid overwhelming the API
        for (let i = 0; i < pagePromises.length; i += 20) {
            await Promise.all(pagePromises.slice(i, i + 20));
        }
    }
}

async function main() {
    showLoading('Loading product list from Health Canada…', 'Fetching all licensed natural health products');
    try {
        // Step 1: Fetch all product routes and build licence number map in parallel.
        // productroute returns every lnhpd_id as a fast flat array.
        // productlicence (paginated, no ?id=) gives us lnhpd_id → licence_number mapping.
        const [routes] = await Promise.all([
            fetchData(`${BASE}/productroute/?lang=en&type=json`),
            buildLicenceNumberMap(),
        ]);

        // Step 2: Deduplicate by lnhpd_id, keeping one route per product
        const seen = new Set();
        allProducts = [];
        routes.forEach(r => {
            if (!seen.has(r.lnhpd_id)) {
                seen.add(r.lnhpd_id);
                allProducts.push({ lnhpd_id: r.lnhpd_id, route_type_desc: r.route_type_desc });
            }
        });

        // Sort by lnhpd_id descending (newest first) as default
        allProducts.sort((a, b) => b.lnhpd_id - a.lnhpd_id);

        filteredIds = allProducts.map(p => p.lnhpd_id);
        currentPage = 1;

        // Step 3: Enrich only the first page so the table renders quickly
        await enrichPage();
        renderAll();

    } catch (err) {
        console.error('Error loading LNHPD data:', err);
        showError();
    }
}

// Enrich the products on the current page by fetching their licence details
async function enrichPage() {
    const sorted   = getSortedIds();
    const start    = (currentPage - 1) * PAGE_SIZE;
    const pageIds  = sorted.slice(start, start + PAGE_SIZE);

    // Fetch in parallel, capped at 10 concurrent to avoid overwhelming the API
    const chunks = [];
    for (let i = 0; i < pageIds.length; i += 10) {
        chunks.push(pageIds.slice(i, i + 10));
    }
    for (const chunk of chunks) {
        await Promise.all(chunk.map(id => fetchLicence(id)));
    }
}

// ── Filtering ───────────────────────────────────────────────────────────────
async function applyFilters() {
    const companyRaw    = document.getElementById('companyFilter').value.trim();
    const ingredientRaw = document.getElementById('ingredientFilter').value.trim();
    const company       = companyRaw.toLowerCase();
    const ingredient    = ingredientRaw.toLowerCase();

    // If no filters, reset to full list
    if (!company && !ingredient) {
        resetFilters();
        return;
    }

    showLoading(
        'Searching across all products…',
        'This may take a moment for ingredient searches'
    );

    // To filter by company or ingredient we need enriched data.
    // For company: productlicence has company_name, so we need to fetch all licences.
    // For ingredient: we search the medicinalingredient endpoint with a name query.
    try {
        let matchingIds = new Set(allProducts.map(p => p.lnhpd_id));

        if (ingredient) {
            // The medicinalingredient endpoint supports ?ingredientname= for searching
            const ingData = await fetchData(
                `${BASE}/medicinalingredient/?ingredientname=${encodeURIComponent(ingredientRaw)}&lang=en&type=json`
            );
            const ingIds = new Set();
            const items = ingData?.data || (Array.isArray(ingData) ? ingData : []);
            items.forEach(i => ingIds.add(i.lnhpd_id));

            // If paginated, fetch additional pages
            if (ingData?.metadata?.pagination) {
                const total = ingData.metadata.pagination.total;
                const limit = ingData.metadata.pagination.limit || 100;
                const pages = Math.ceil(total / limit);
                // Cap at 20 pages (~2000 results) to keep it responsive
                const pagesToFetch = Math.min(pages, 20);
                const pagePromises = [];
                for (let p = 2; p <= pagesToFetch; p++) {
                    pagePromises.push(
                        fetchData(`${BASE}/medicinalingredient/?ingredientname=${encodeURIComponent(ingredientRaw)}&lang=en&type=json&page=${p}`)
                            .then(d => {
                                const rows = d?.data || (Array.isArray(d) ? d : []);
                                rows.forEach(i => ingIds.add(i.lnhpd_id));
                            })
                            .catch(() => {})
                    );
                }
                await Promise.all(pagePromises);
            }

            matchingIds = new Set([...matchingIds].filter(id => ingIds.has(id)));
        }

        if (company) {
            // For company filtering, we must enrich all matching products.
            // We batch-fetch up to 500 for performance; warn if truncated.
            const idsToCheck = [...matchingIds];
            const COMPANY_LIMIT = 500;
            const idsForCompany = idsToCheck.slice(0, COMPANY_LIMIT);

            // Fetch all in parallel, batched by 10
            for (let i = 0; i < idsForCompany.length; i += 10) {
                await Promise.all(idsForCompany.slice(i, i + 10).map(id => fetchLicence(id)));
            }

            const companyMatches = new Set(
                idsForCompany.filter(id => {
                    const e = enrichedCache[id];
                    return e && e.company_name.toLowerCase().includes(company);
                })
            );
            matchingIds = companyMatches;
        }

        filteredIds = allProducts
            .map(p => p.lnhpd_id)
            .filter(id => matchingIds.has(id));

        currentPage = 1;
        await enrichPage();
        renderAll();
        renderPills(companyRaw, ingredientRaw);

    } catch (err) {
        console.error('Filter error:', err);
        showError();
    }
}

async function resetFilters() {
    document.getElementById('companyFilter').value    = '';
    document.getElementById('ingredientFilter').value = '';
    filteredIds = allProducts.map(p => p.lnhpd_id);
    currentPage = 1;
    await enrichPage();
    renderAll();
    renderPills('', '');
}

function clearPill(field) {
    document.getElementById(field).value = '';
    applyFilters();
}

// ── Sorting ──────────────────────────────────────────────────────────────────
function toggleSort(key) {
    if (sortKey === key) {
        sortDir = sortDir === 'asc' ? 'desc' : 'asc';
    } else {
        sortKey = key;
        sortDir = 'asc';
    }
    currentPage = 1;
    // Re-enrich the new first page then re-render
    enrichPage().then(() => renderAll());
}

function getSortedIds() {
    // lnhpd_id is always available immediately (no enrichment needed) — sort numerically
    if (sortKey === 'lnhpd_id') {
        return sortDir === 'desc'
            ? [...filteredIds].sort((a, b) => b - a)
            : [...filteredIds].sort((a, b) => a - b);
    }
    // For all enriched fields (including licence_number), sort on cached values;
    // uncached items fall to the end
    return [...filteredIds].sort((a, b) => {
        const ea = enrichedCache[a];
        const eb = enrichedCache[b];
        const va = ea ? (ea[sortKey] || '') : '';
        const vb = eb ? (eb[sortKey] || '') : '';
        const cmp = String(va).localeCompare(String(vb), undefined, { numeric: true });
        return sortDir === 'asc' ? cmp : -cmp;
    });
}

// ── Rendering ────────────────────────────────────────────────────────────────
function renderAll() {
    renderResultsMeta();
    renderTable();
    renderPagination();
}

function renderResultsMeta() {
    const meta  = document.getElementById('resultsMeta');
    const count = document.getElementById('resultsCount');
    meta.style.display = 'flex';
    count.innerHTML = `Showing <strong>${filteredIds.length.toLocaleString()}</strong> of <strong>${allProducts.length.toLocaleString()}</strong> products`;
}

function renderTable() {
    const container = document.getElementById('table-container');

    if (filteredIds.length === 0) {
        container.innerHTML = `
            <div class="state-box">
                <div class="state-icon">🔍</div>
                <div class="state-title">No results found</div>
                <div class="state-body">Try adjusting or clearing your filters.</div>
            </div>`;
        return;
    }

    const sorted   = getSortedIds();
    const start    = (currentPage - 1) * PAGE_SIZE;
    const pageIds  = sorted.slice(start, start + PAGE_SIZE);

    const wrapper = document.createElement('div');
    wrapper.className = 'table-wrapper';
    const scroll = document.createElement('div');
    scroll.className = 'table-scroll';
    const table = document.createElement('table');

    // Header
    const thead = table.createTHead();
    const headerRow = thead.insertRow();
    COLUMNS.forEach(col => {
        const th = document.createElement('th');
        th.textContent = col.label;
        th.onclick = () => toggleSort(col.key);
        if (col.key === sortKey) th.classList.add(sortDir === 'asc' ? 'sort-asc' : 'sort-desc');
        headerRow.appendChild(th);
    });

    // Body
    const tbody = document.createElement('tbody');
    pageIds.forEach(id => {
        const obj = enrichedCache[id] || { lnhpd_id: id };
        const row = tbody.insertRow();

        COLUMNS.forEach(col => {
            const td = row.insertCell();
            if (col.cls) td.className = col.cls;

            const isLoaded = !!enrichedCache[id];

            if (col.key === 'licence_number') {
                // Show licence_number if enriched, otherwise show a shimmer
                const a = document.createElement('a');
                a.href    = '#';
                a.title   = 'View full product details';
                a.onclick = e => { e.preventDefault(); openModal(id); };
                if (isLoaded && obj.licence_number !== '—') {
                    a.textContent = obj.licence_number;
                    td.appendChild(a);
                } else if (!isLoaded) {
                    const shimmer = document.createElement('span');
                    shimmer.className = 'cell-loading';
                    td.appendChild(shimmer);
                } else {
                    // Enriched but no licence_number — fall back to lnhpd_id as link text
                    a.textContent = id;
                    td.appendChild(a);
                }

            } else if (col.key === 'flag_product_status' && isLoaded) {
                const status = obj[col.key] || '—';
                if (status !== '—') {
                    const badge = document.createElement('span');
                    badge.className = `badge ${status === 'Active' ? 'badge-active' : 'badge-inactive'}`;
                    badge.textContent = status;
                    td.appendChild(badge);
                } else {
                    td.textContent = '—';
                }

            } else if (!isLoaded && col.key !== 'lnhpd_id') {
                // Show shimmer skeleton while this row's licence data loads
                const shimmer = document.createElement('span');
                shimmer.className = 'cell-loading';
                td.appendChild(shimmer);

            } else {
                td.textContent = obj[col.key] || '—';
            }
        });
    });

    table.appendChild(tbody);
    scroll.appendChild(table);
    wrapper.appendChild(scroll);
    container.innerHTML = '';
    container.appendChild(wrapper);

    // After rendering with skeletons, fetch any missing enrichments and re-render
    const missing = pageIds.filter(id => !enrichedCache[id]);
    if (missing.length > 0) {
        Promise.all(missing.map(id => fetchLicence(id))).then(() => {
            // Only re-render if we're still on the same page
            renderTable();
        });
    }
}

function renderPagination() {
    const container  = document.getElementById('pagination');
    const totalPages = Math.ceil(filteredIds.length / PAGE_SIZE);
    container.innerHTML = '';
    if (totalPages <= 1) return;

    const makeBtn = (label, page, disabled, active) => {
        const btn = document.createElement('button');
        btn.className   = 'page-btn' + (active ? ' active' : '');
        btn.textContent = label;
        btn.disabled    = disabled;
        btn.onclick     = async () => {
            currentPage = page;
            window.scrollTo({ top: 0, behavior: 'smooth' });
            showLoading('Loading page…', '');
            await enrichPage();
            renderAll();
        };
        return btn;
    };

    container.appendChild(makeBtn('←', currentPage - 1, currentPage === 1, false));

    const win = 5;
    let start = Math.max(1, currentPage - Math.floor(win / 2));
    let end   = Math.min(totalPages, start + win - 1);
    if (end - start + 1 < win) start = Math.max(1, end - win + 1);

    if (start > 1) {
        container.appendChild(makeBtn('1', 1, false, false));
        if (start > 2) {
            const el = document.createElement('span');
            el.textContent = '…'; el.style.padding = '0 4px'; el.style.color = 'var(--grey-300)';
            container.appendChild(el);
        }
    }
    for (let p = start; p <= end; p++) {
        container.appendChild(makeBtn(p, p, false, p === currentPage));
    }
    if (end < totalPages) {
        if (end < totalPages - 1) {
            const el = document.createElement('span');
            el.textContent = '…'; el.style.padding = '0 4px'; el.style.color = 'var(--grey-300)';
            container.appendChild(el);
        }
        container.appendChild(makeBtn(totalPages, totalPages, false, false));
    }

    container.appendChild(makeBtn('→', currentPage + 1, currentPage === totalPages, false));
}

function renderPills(company, ingredient) {
    const pillsContainer = document.getElementById('activePills');
    pillsContainer.innerHTML = '';
    const addPill = (label, field) => {
        const pill = document.createElement('div');
        pill.className = 'filter-pill';
        pill.innerHTML = `${label} <button onclick="clearPill('${field}')" title="Remove filter">✕</button>`;
        pillsContainer.appendChild(pill);
    };
    if (company)    addPill(`Company: ${company}`,         'companyFilter');
    if (ingredient) addPill(`Ingredient: ${ingredient}`,   'ingredientFilter');
}

// ── Loading / error states ────────────────────────────────────────────────────
function showLoading(label = 'Loading…', sub = '') {
    document.getElementById('table-container').innerHTML = `
        <div class="loading-state">
            <div class="spinner"></div>
            <span class="loading-label">${label}</span>
            ${sub ? `<span class="loading-sub">${sub}</span>` : ''}
        </div>`;
    document.getElementById('pagination').innerHTML = '';
    document.getElementById('resultsMeta').style.display = 'none';
}

function showError() {
    document.getElementById('table-container').innerHTML = `
        <div class="state-box">
            <div class="state-icon">⚠️</div>
            <div class="state-title">Couldn't load data</div>
            <div class="state-body">There was a problem reaching the Health Canada API. Please check your connection and reload the page.</div>
        </div>`;
}

// ── Modal ─────────────────────────────────────────────────────────────────────
function openModal(lnhpdId) {
    const root = document.getElementById('modal-root');
    const cached = enrichedCache[lnhpdId];
    const productName = cached?.product_name || `Product ${lnhpdId}`;

    root.innerHTML = `
        <div class="modal-backdrop" id="modalBackdrop">
            <div class="modal" role="dialog" aria-modal="true" aria-label="Product details for NHP Licence ${cached?.licence_number || lnhpdId}">
                <div class="modal-header">
                    <div>
                        <div class="modal-id">NHP Licence # ${cached?.licence_number || lnhpdId}</div>
                        <h2>${productName}</h2>
                    </div>
                    <button class="modal-close" onclick="closeModal()" aria-label="Close">✕</button>
                </div>
                <div class="modal-body">
                    <div class="modal-loading">
                        <div class="spinner"></div>
                        <span>Loading product details…</span>
                    </div>
                </div>
            </div>
        </div>`;

    document.getElementById('modalBackdrop').addEventListener('click', e => {
        if (e.target === e.currentTarget) closeModal();
    });
    document._modalEsc = e => { if (e.key === 'Escape') closeModal(); };
    document.addEventListener('keydown', document._modalEsc);

    fetchModalData(lnhpdId).then(html => {
        const body = document.querySelector('.modal-body');
        if (body) body.innerHTML = html;
        // Update header with fetched licence_number and product name
        const modalId = document.querySelector('.modal-id');
        const h2      = document.querySelector('.modal-header h2');
        if (enrichedCache[lnhpdId]) {
            if (modalId) modalId.textContent = `NHP Licence # ${enrichedCache[lnhpdId].licence_number}`;
            if (h2)      h2.textContent      = enrichedCache[lnhpdId].product_name;
        }
    });
}

function closeModal() {
    document.getElementById('modal-root').innerHTML = '';
    document.removeEventListener('keydown', document._modalEsc);
}

async function fetchModalData(lnhpdId) {
    try {
        const licenceNumber = licenceNumberMap[lnhpdId];

        // NOTE per API docs:
        //   productlicence  → ?id= expects licence_number
        //   all other endpoints → ?id= expects lnhpd_id
        const [
            licenceData,
            ingredients,
            nonMedicinal,
            routes,
            purposes,
            risks,
            dose,
        ] = await Promise.all([
            licenceNumber
                ? fetchData(`${BASE}/productlicence/?id=${licenceNumber}&lang=en&type=json`)
                : Promise.resolve(null),
            fetchData(`${BASE}/medicinalingredient/?id=${lnhpdId}&lang=en&type=json`),
            fetchData(`${BASE}/nonmedicinalingredient/?id=${lnhpdId}&lang=en&type=json`),
            fetchData(`${BASE}/productroute/?id=${lnhpdId}&lang=en&type=json`),
            fetchData(`${BASE}/productpurpose/?id=${lnhpdId}&lang=en&type=json`),
            fetchData(`${BASE}/productrisk/?id=${lnhpdId}&lang=en&type=json`),
            fetchData(`${BASE}/productdose/?id=${lnhpdId}&lang=en&type=json`),
        ]);

        const licence = Array.isArray(licenceData) ? licenceData[0] : licenceData;

        // Update cache with freshly fetched licence data
        if (licence) {
            enrichedCache[lnhpdId] = {
                ...enrichedCache[lnhpdId],
                licence_number:      licence.licence_number || licenceNumber || '—',
                product_name:        licence.product_name   || '—',
                company_name:        licence.company_name   || '—',
                dosage_form:         licence.dosage_form    || '—',
                licence_date:        licence.licence_date   || '—',
                flag_product_status: licence.flag_product_status != null
                    ? (licence.flag_product_status === 1 ? 'Active' : 'Inactive') : '—',
                _raw: licence,
            };
        }

        return buildModalHTML(licence, ingredients, nonMedicinal, routes, purposes, risks, dose);
    } catch (err) {
        console.error('Modal fetch error:', err);
        return `<div class="modal-error">⚠️ Could not load product details. Please try again.</div>`;
    }
}

function v(val) {
    if (val === null || val === undefined || val === '' || val === 0) return '—';
    return val;
}

function field(label, value, fullWidth = false) {
    return `<div class="modal-field${fullWidth ? ' full-width' : ''}">
        <label>${label}</label><span>${v(value)}</span>
    </div>`;
}

function toList(data) {
    if (!data) return [];
    // Handle paginated {data:[...]} responses and plain arrays
    if (data.data && Array.isArray(data.data)) return data.data;
    return Array.isArray(data) ? data : [data];
}

function buildModalHTML(licence, ingredients, nonMedicinal, routes, purposes, risks, dose) {
    const sections = [];

    // ── Product overview ──────────────────────────────────────────────────────
    // Field names exactly per productlicence API docs
    if (licence) {
        const status = licence.flag_product_status != null
            ? (licence.flag_product_status === 1 ? 'Active' : 'Inactive') : '—';
        sections.push(`
            <div class="modal-section">
                <div class="modal-section-title">Product overview</div>
                <div class="modal-grid">
                    ${field('Licence #',             licence.licence_number)}
                    ${field('Product name',          licence.product_name)}
                    ${field('Company',               licence.company_name)}
                    ${field('Dosage form',           licence.dosage_form)}
                    ${field('Licence date',          licence.licence_date)}
                    ${field('Revised date',          licence.revised_date)}
                    ${field('Date received',         licence.time_receipt)}
                    ${field('Status',                status)}
                    ${field('Submission type',       licence.sub_submission_type_desc)}
                    ${field('Attested to monograph', licence.flag_attested_monograph === 1 ? 'Yes' : licence.flag_attested_monograph === 0 ? 'No' : '—')}
                </div>
            </div>`);
    }

    // ── Medicinal ingredients ─────────────────────────────────────────────────
    // Field names exactly per medicinalingredient API docs
    const ingList = toList(ingredients);
    if (ingList.length > 0) {
        const rows = ingList.map(i => {
            const qty     = (i.quantity && i.quantity !== 0)
                ? `${v(i.quantity)} ${v(i.quantity_unit_of_measure)}` : '—';
            const potency = (i.potency_amount && i.potency_amount !== 0)
                ? `${v(i.potency_amount)} ${v(i.potency_unit_of_measure)}` : '—';
            const dhe     = (i.dried_herb_equivalent && i.dried_herb_equivalent !== '0')
                ? `${v(i.dried_herb_equivalent)} ${v(i.dhe_unit_of_measure)}` : '—';
            return `
            <tr>
                <td>${v(i.ingredient_name)}</td>
                <td>${v(i.source_material)}</td>
                <td>${qty}</td>
                <td>${potency}</td>
                <td>${dhe}</td>
            </tr>`;
        }).join('');
        sections.push(`
            <div class="modal-section">
                <div class="modal-section-title">Medicinal ingredients</div>
                <table class="modal-table">
                    <thead><tr>
                        <th>Ingredient</th>
                        <th>Source material</th>
                        <th>Quantity</th>
                        <th>Potency</th>
                        <th>Dried herb equivalent</th>
                    </tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>`);
    }

    // ── Non-medicinal ingredients ─────────────────────────────────────────────
    // Field names per nonmedicinalingredient API docs: ingredient_name only (no role field in API)
    const nonMedList = toList(nonMedicinal);
    if (nonMedList.length > 0) {
        const items = nonMedList.map(n => `<li>${v(n.ingredient_name)}</li>`).join('');
        sections.push(`
            <div class="modal-section">
                <div class="modal-section-title">Non-medicinal ingredients</div>
                <ul style="margin:0;padding-left:18px;font-size:13px;line-height:2">${items}</ul>
            </div>`);
    }

    // ── Routes of administration ──────────────────────────────────────────────
    // Field names per productroute API docs: route_type_desc
    const routeList = toList(routes);
    if (routeList.length > 0) {
        sections.push(`
            <div class="modal-section">
                <div class="modal-section-title">Route of administration</div>
                <div class="modal-grid">
                    ${routeList.map(r => field('Route', r.route_type_desc)).join('')}
                </div>
            </div>`);
    }

    // ── Dosage ────────────────────────────────────────────────────────────────
    // Field names per productdose API docs
    const doseList = toList(dose);
    if (doseList.length > 0) {
        const rows = doseList.map(d => {
            const qty  = (d.quantity_dose && d.quantity_dose !== 0)
                ? `${v(d.quantity_dose)} ${v(d.uom_type_desc_quantity_dose)}` : '—';
            const freq = (d.frequency && d.frequency !== 0)
                ? `${v(d.frequency)} ${v(d.uom_type_desc_frequency)}` : '—';
            const age  = (d.age && d.age !== 0)
                ? `${v(d.age)} ${v(d.uom_type_desc_age)}` : '—';
            return `
            <tr>
                <td>${v(d.population_type_desc)}</td>
                <td>${qty}</td>
                <td>${freq}</td>
                <td>${age}</td>
            </tr>`;
        }).join('');
        sections.push(`
            <div class="modal-section">
                <div class="modal-section-title">Dosage</div>
                <table class="modal-table">
                    <thead><tr>
                        <th>Population</th>
                        <th>Quantity</th>
                        <th>Frequency</th>
                        <th>Age</th>
                    </tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>`);
    }

    // ── Purposes / health claims ──────────────────────────────────────────────
    // Field names per productpurpose API docs: purpose (not purpose_desc or purpose_desc_en)
    const purposeList = toList(purposes);
    if (purposeList.length > 0) {
        const rows = purposeList.map(p => `
            <tr><td>${v(p.purpose)}</td></tr>`).join('');
        sections.push(`
            <div class="modal-section">
                <div class="modal-section-title">Purposes / health claims</div>
                <table class="modal-table">
                    <thead><tr><th>Claim</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>`);
    }

    // ── Risk information ──────────────────────────────────────────────────────
    // Field names per productrisk API docs: risk_type_desc, sub_risk_type_desc, risk_text
    const riskList = toList(risks);
    if (riskList.length > 0) {
        const rows = riskList.map(r => `
            <tr>
                <td>${v(r.risk_type_desc)}</td>
                <td>${v(r.sub_risk_type_desc)}</td>
                <td>${v(r.risk_text)}</td>
            </tr>`).join('');
        sections.push(`
            <div class="modal-section">
                <div class="modal-section-title">Risk information</div>
                <table class="modal-table">
                    <thead><tr><th>Type</th><th>Sub-type</th><th>Statement</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>`);
    }

    if (sections.length === 0) {
        return `<div class="modal-error">No detailed information available for this product.</div>`;
    }

    return sections.join('');
}

// ── Bootstrap ────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    ['companyFilter', 'ingredientFilter'].forEach(id => {
        document.getElementById(id).addEventListener('keydown', e => {
            if (e.key === 'Enter') applyFilters();
        });
    });
    main();
});
