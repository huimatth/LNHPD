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