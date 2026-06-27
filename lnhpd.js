// ── State ──────────────────────────────────────────────────────────────────
let allProducts      = [];   // full deduplicated list of {lnhpd_id, route_type_desc}
let enrichedCache    = {};   // lnhpd_id → enriched product object (cached after first fetch)
let licenceNumberMap = {};   // lnhpd_id → { licence_number, licence_date } (built at startup)
let filteredIds      = [];   // lnhpd_ids after filtering
let currentPage      = 1;
const PAGE_SIZE      = 25;
let sortKey          = 'licence_number';
let sortDir          = 'desc';
let activeDays       = 90;   // date window: 90 | 180 | 360

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
        const mapEntry      = licenceNumberMap[lnhpdId];
        const licenceNumber = mapEntry?.licence_number;
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
            licence_date:        licence?.licence_date                                || mapEntry?.licence_date || '—',
            flag_product_status: licence?.flag_product_status != null
                                     ? (licence.flag_product_status === 1 ? 'Active' : 'Inactive')
                                     : '—',
            route_type_desc:     route?.route_type_desc                               || '—',
            _raw:                licence,
        };
        enrichedCache[lnhpdId] = enriched;
        return enriched;
    } catch {
        const mapEntry = licenceNumberMap[lnhpdId];
        return {
            lnhpd_id:            lnhpdId,
            licence_number:      mapEntry?.licence_number || '—',
            product_name:        '—',
            company_name:        '—',
            dosage_form:         '—',
            licence_date:        mapEntry?.licence_date   || '—',
            flag_product_status: '—',
            route_type_desc:     allProducts.find(p => p.lnhpd_id === lnhpdId)?.route_type_desc || '—',
            _raw:                null,
        };
    }
}

// ── Data loading ─────────────────────────────────────────────────────────────

// Build lnhpd_id → { licence_number, licence_date } map by paginating through productlicence.
// productlicence without ?id= returns all licences paginated.
// Each record contains lnhpd_id, licence_number, and licence_date — all we need for date filtering.
async function buildLicenceNumberMap() {
    const firstPage = await fetchData(`${BASE}/productlicence/?lang=en&type=json`);
    const records   = firstPage?.data || (Array.isArray(firstPage) ? firstPage : []);
    records.forEach(r => {
        if (r.lnhpd_id && r.licence_number) {
            licenceNumberMap[r.lnhpd_id] = { licence_number: r.licence_number, licence_date: r.licence_date || null };
        }
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
                                licenceNumberMap[r.lnhpd_id] = { licence_number: r.licence_number, licence_date: r.licence_date || null };
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
    showLoading('Loading product list from Health Canada…', 'Fetching licensed natural health products');
    try {
        // Step 1: Fetch all product routes and build licence number map in parallel.
        // productroute returns every lnhpd_id as a fast flat array.
        // productlicence (paginated, no ?id=) gives us lnhpd_id → { licence_number, licence_date }.
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

        // Step 3: Apply the default 90-day date window and render
        applyDateWindow();

    } catch (err) {
        console.error('Error loading LNHPD data:', err);
        showError();
    }
}

// Returns the lnhpd_ids whose licence_date falls within the active date window.
// Uses licenceNumberMap which holds licence_date from the bulk productlicence fetch.
function getDateWindowIds() {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - activeDays);
    return allProducts
        .map(p => p.lnhpd_id)
        .filter(id => {
            const entry = licenceNumberMap[id];
            if (!entry?.licence_date) return false;
            return new Date(entry.licence_date) >= cutoff;
        });
}

// Called when the date window toggle changes or on initial load.
async function applyDateWindow() {
    // Update toggle button active states
    document.querySelectorAll('.date-toggle-btn').forEach(btn => {
        btn.classList.toggle('active', parseInt(btn.dataset.days) === activeDays);
    });

    filteredIds = getDateWindowIds();
    currentPage = 1;

    // Re-apply any existing text filters on top of the new date window
    const companyRaw    = document.getElementById('companyFilter').value.trim();
    const ingredientRaw = document.getElementById('ingredientFilter').value.trim();
    if (companyRaw || ingredientRaw) {
        // Let applyFilters handle the combined logic
        await applyFilters();
        return;
    }

    await enrichPage();
    renderAll();
    renderPills(companyRaw, ingredientRaw);
}

// Called by the UI toggle buttons
async function setDateWindow(days) {
    if (activeDays === days) return;
    activeDays = days;
    showLoading(`Loading last ${days} days…`, '');
    await applyDateWindow();
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

    // Start from the date-windowed set, not all products
    const dateWindowIds = getDateWindowIds();

    // If no text filters, just apply the date window
    if (!company && !ingredient) {
        filteredIds = dateWindowIds;
        currentPage = 1;
        await enrichPage();
        renderAll();
        renderPills('', '');
        return;
    }

    showLoading(
        'Searching across products…',
        'This may take a moment for ingredient searches'
    );

    try {
        let matchingIds = new Set(dateWindowIds);

        if (ingredient) {
            const ingData = await fetchData(
                `${BASE}/medicinalingredient/?ingredientname=${encodeURIComponent(ingredientRaw)}&lang=en&type=json`
            );
            const ingIds = new Set();
            const items = ingData?.data || (Array.isArray(ingData) ? ingData : []);
            items.forEach(i => ingIds.add(i.lnhpd_id));

            if (ingData?.metadata?.pagination) {
                const total = ingData.metadata.pagination.total;
                const limit = ingData.metadata.pagination.limit || 100;
                const pages = Math.ceil(total / limit);
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

            // Intersect with date window
            matchingIds = new Set([...matchingIds].filter(id => ingIds.has(id)));
        }

        if (company) {
            const idsToCheck   = [...matchingIds];
            const COMPANY_LIMIT = 500;
            const idsForCompany = idsToCheck.slice(0, COMPANY_LIMIT);

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
    // Reset text filters but keep the current date window
    filteredIds = getDateWindowIds();
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

// ── Export Filtered Set to CSV ──────────────────────────────────────────────
async function exportFilteredSet() {
    if (!filteredIds || filteredIds.length === 0) return;

    const btn = document.getElementById('downloadBtn');
    const originalText = btn.innerHTML;
    
    btn.disabled = true;
    btn.style.opacity = '0.6';
    btn.innerHTML = '⏳ Processing...';

    try {
        const missingIds = filteredIds.filter(id => !enrichedCache[id]);
        
        if (missingIds.length > 0) {
            btn.innerHTML = `⏳ Fetching ${missingIds.length} items...`;
            
            const BATCH_SIZE = 15;
            for (let i = 0; i < missingIds.length; i += BATCH_SIZE) {
                const batch = missingIds.slice(i, i + BATCH_SIZE);
                await Promise.all(batch.map(id => fetchLicence(id)));
            }
        }

        btn.innerHTML = '✍️ Generating file...';

        const headers = ['Licence Number', 'Product Name', 'Company Name', 'Dosage Form', 'Route', 'Licence Date', 'Status'];
        
        const escapeCSV = (val) => {
            if (val === null || val === undefined) return '""';
            let str = String(val).replace(/"/g, '""');
            return `"${str}"`;
        };

        const csvRows = [headers.join(',')];
        const sortedIds = getSortedIds(); 
        
        sortedIds.forEach(id => {
            const item = enrichedCache[id];
            if (item) {
                const rowData = [
                    escapeCSV(item.licence_number),
                    escapeCSV(item.product_name),
                    escapeCSV(item.company_name),
                    escapeCSV(item.dosage_form),
                    escapeCSV(item.route_type_desc),
                    escapeCSV(item.licence_date),
                    escapeCSV(item.flag_product_status)
                ];
                csvRows.push(rowData.join(','));
            }
        });

        const csvContent = csvRows.join('\n');
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        
        link.setAttribute('href', url);
        link.setAttribute('download', `hc_lnhpd_extract_${activeDays}days.csv`);
        link.style.visibility = 'hidden';
        
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);

    } catch (err) {
        console.error('Failed to export CSV data:', err);
        alert('An error occurred while compiling the data export. Please try again.');
    } finally {
        btn.disabled = false;
        btn.style.opacity = '1';
        btn.innerHTML = originalText;
    }
}

function closeModal() {
    document.getElementById('modal-root').innerHTML = '';
    document.removeEventListener('keydown', document._modalEsc);
}

async function fetchModalData(lnhpdId) {
    try {
        const licenceNumber = licenceNumberMap[lnhpdId]?.licence_number;

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
                licence_date:        licence.licence_date   || licenceNumberMap[lnhpdId]?.licence_date || '—',
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

// ... Rest of file (buildModalHTML and bootstrap window event listener) remains exactly identical