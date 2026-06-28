// ── State ──────────────────────────────────────────────────────────────────
let allProducts      = [];
let enrichedCache    = {};
let licenceNumberMap = {};
let filteredIds      = [];
let currentPage      = 1;
const PAGE_SIZE      = 25;
let sortKey          = 'licence_date';
let sortDir          = 'desc';
let activeDays       = 90;
let routeFilter      = '';
let statusFilter     = '';
let routeIdMap       = {};
let debounceTimer    = null;
let ingredientCache  = {};  // lnhpd_id → [lowercase ingredient names]

// ── Column definitions ──────────────────────────────────────────────────────
const COLUMNS = [
    { key: 'licence_number',      label: 'Licence #',    cls: 'col-licence', modal: true },
    { key: 'product_name',        label: 'Product name', cls: 'col-brand' },
    { key: 'company_name',        label: 'Company' },
    { key: 'dosage_form',         label: 'Dosage form' },
    { key: 'route_type_desc',     label: 'Route' },
    { key: 'licence_date',        label: 'Licence date', cls: 'col-date' },
    { key: 'flag_product_status', label: 'Status',       cls: 'col-status' },
];

// ── Utility ───────────────────────────────────────────────────────────────────
function escHtml(str) {
    return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function v(val) {
    if (val === null || val === undefined || val === '' || val === 0) return '—';
    return val;
}

// ── Fetch helpers ───────────────────────────────────────────────────────────
const BASE = 'https://health-products.canada.ca/api/natural-licences';

async function fetchData(url, retries = 3) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const res  = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const text = await res.text();
            if (!text || !text.trim()) throw new Error('Empty response');
            return JSON.parse(text);
        } catch (err) {
            if (attempt === retries) throw err;
            await new Promise(r => setTimeout(r, 600 * (attempt + 1)));
        }
    }
}

async function fetchIngredients(lnhpdId) {
    if (ingredientCache[lnhpdId] !== undefined) return ingredientCache[lnhpdId];
    try {
        const data  = await fetchData(`${BASE}/medicinalingredient/?id=${lnhpdId}&lang=en&type=json`);
        const items = data?.data || (Array.isArray(data) ? data : []);
        ingredientCache[lnhpdId] = items.map(i => (i.ingredient_name || '').toLowerCase());
        return ingredientCache[lnhpdId];
    } catch {
        ingredientCache[lnhpdId] = [];
        return [];
    }
}

async function fetchLicence(lnhpdId) {
    if (enrichedCache[lnhpdId]) return enrichedCache[lnhpdId];
    try {
        const mapEntry      = licenceNumberMap[lnhpdId];
        const licenceNumber = mapEntry?.licence_number;
        if (!licenceNumber) throw new Error(`No licence_number for lnhpd_id ${lnhpdId}`);

        const data    = await fetchData(`${BASE}/productlicence/?id=${licenceNumber}&lang=en&type=json`);
        const licence = Array.isArray(data) ? data[0] : data;
        const enriched = {
            lnhpd_id:               lnhpdId,
            licence_number:         licence?.licence_number         || licenceNumber,
            product_name:           licence?.product_name           || mapEntry?.product_name || '—',
            company_name:           licence?.company_name           || mapEntry?.company_name || '—',
            dosage_form:            licence?.dosage_form            || mapEntry?.dosage_form  || '—',
            licence_date:           licence?.licence_date           || mapEntry?.licence_date || '—',
            revised_date:           licence?.revised_date           || mapEntry?.revised_date || '—',
            time_receipt:           licence?.time_receipt           || mapEntry?.time_receipt || '—',
            sub_submission_type_desc: licence?.sub_submission_type_desc || mapEntry?.sub_submission_type_desc || '—',
            flag_product_status:    licence?.flag_product_status != null
                                        ? (licence.flag_product_status === 1 ? 'Active' : 'Inactive')
                                        : (mapEntry?.flag_product_status || '—'),
            route_type_desc:        routeIdMap[lnhpdId]             || '—',
            _raw:                   licence,
        };
        enrichedCache[lnhpdId] = enriched;
        return enriched;
    } catch {
        const mapEntry = licenceNumberMap[lnhpdId];
        return (enrichedCache[lnhpdId] = {
            lnhpd_id:               lnhpdId,
            licence_number:         mapEntry?.licence_number          || '—',
            product_name:           mapEntry?.product_name            || '—',
            company_name:           mapEntry?.company_name            || '—',
            dosage_form:            mapEntry?.dosage_form             || '—',
            licence_date:           mapEntry?.licence_date            || '—',
            revised_date:           mapEntry?.revised_date            || '—',
            time_receipt:           mapEntry?.time_receipt            || '—',
            sub_submission_type_desc: mapEntry?.sub_submission_type_desc || '—',
            flag_product_status:    mapEntry?.flag_product_status     || '—',
            route_type_desc:        routeIdMap[lnhpdId]               || '—',
            _raw:                   null,
        });
    }
}

// ── Data loading ─────────────────────────────────────────────────────────────
async function buildLicenceNumberMap() {
    const firstPage = await fetchData(`${BASE}/productlicence/?lang=en&type=json`);
    const records   = firstPage?.data || (Array.isArray(firstPage) ? firstPage : []);
    records.forEach(r => {
        if (r.lnhpd_id && r.licence_number) {
            licenceNumberMap[r.lnhpd_id] = {
                licence_number:         r.licence_number,
                licence_date:           r.licence_date           || null,
                revised_date:           r.revised_date           || null,
                time_receipt:           r.time_receipt           || null,
                company_name:           r.company_name           || '',
                product_name:           r.product_name           || '',
                dosage_form:            r.dosage_form            || '',
                sub_submission_type_desc: r.sub_submission_type_desc || '',
                flag_product_status:    r.flag_product_status != null
                                            ? (r.flag_product_status === 1 ? 'Active' : 'Inactive')
                                            : null,
            };
        }
    });

    const pagination = firstPage?.metadata?.pagination;
    if (pagination?.total && pagination?.limit) {
        const totalPages   = Math.ceil(pagination.total / pagination.limit);
        const pagePromises = [];
        for (let p = 2; p <= totalPages; p++) {
            pagePromises.push(
                fetchData(`${BASE}/productlicence/?lang=en&type=json&page=${p}`)
                    .then(d => {
                        const rows = d?.data || (Array.isArray(d) ? d : []);
                        rows.forEach(r => {
                            if (r.lnhpd_id && r.licence_number) {
                                licenceNumberMap[r.lnhpd_id] = {
                                    licence_number:         r.licence_number,
                                    licence_date:           r.licence_date           || null,
                                    revised_date:           r.revised_date           || null,
                                    time_receipt:           r.time_receipt           || null,
                                    company_name:           r.company_name           || '',
                                    product_name:           r.product_name           || '',
                                    dosage_form:            r.dosage_form            || '',
                                    sub_submission_type_desc: r.sub_submission_type_desc || '',
                                    flag_product_status:    r.flag_product_status != null
                                                                ? (r.flag_product_status === 1 ? 'Active' : 'Inactive')
                                                                : null,
                                };
                            }
                        });
                    })
                    .catch(() => {})
            );
        }
        for (let i = 0; i < pagePromises.length; i += 20) {
            await Promise.all(pagePromises.slice(i, i + 20));
        }
    }
}

async function main() {
    showLoading('Loading product list from Health Canada…', 'Fetching licensed natural health products');
    try {
        const [routes] = await Promise.all([
            fetchData(`${BASE}/productroute/?lang=en&type=json`),
            buildLicenceNumberMap(),
        ]);

        const seen = new Set();
        allProducts = [];
        routes.forEach(r => {
            if (!seen.has(r.lnhpd_id)) {
                seen.add(r.lnhpd_id);
                allProducts.push({ lnhpd_id: r.lnhpd_id, route_type_desc: r.route_type_desc });
            }
        });

        allProducts.forEach(p => { routeIdMap[p.lnhpd_id] = p.route_type_desc || ''; });

        populateRouteSelect();
        populateQuickFilters();
        applyDateWindow();

    } catch (err) {
        console.error('Error loading LNHPD data:', err);
        showError();
    }
}

// ── Date window helpers ───────────────────────────────────────────────────────
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

async function applyDateWindow() {
    document.querySelectorAll('.date-toggle-btn').forEach(btn => {
        btn.classList.toggle('active', parseInt(btn.dataset.days) === activeDays);
    });
    currentPage = 1;
    const companyRaw    = document.getElementById('companyFilter').value.trim();
    const ingredientRaw = document.getElementById('ingredientFilter').value.trim();
    if (companyRaw || ingredientRaw || statusFilter) {
        await applyFilters();
        return;
    }
    filteredIds = applyRouteFilterToIds(getDateWindowIds());
    await enrichPage();
    renderAll();
    renderPills(companyRaw, ingredientRaw);
}

async function setDateWindow(days) {
    if (activeDays === days) return;
    activeDays = days;
    showLoading(`Loading last ${days} days…`, '');
    await applyDateWindow();
}

// ── Filter helpers ───────────────────────────────────────────────────────────
function applyRouteFilterToIds(ids) {
    if (!routeFilter) return ids;
    return ids.filter(id => routeIdMap[id] === routeFilter);
}

function applyStatusFilterToIds(ids) {
    if (!statusFilter) return ids;
    return ids.filter(id => {
        const e = enrichedCache[id];
        return e && e.flag_product_status === statusFilter;
    });
}

async function enrichPage() {
    const sorted  = getSortedIds();
    const start   = (currentPage - 1) * PAGE_SIZE;
    const pageIds = sorted.slice(start, start + PAGE_SIZE);
    const chunks  = [];
    for (let i = 0; i < pageIds.length; i += 10) chunks.push(pageIds.slice(i, i + 10));
    for (const chunk of chunks) await Promise.all(chunk.map(id => fetchLicence(id)));
}

// ── Main filter pipeline ─────────────────────────────────────────────────────
async function applyFilters() {
    const companyRaw    = document.getElementById('companyFilter').value.trim();
    const ingredientRaw = document.getElementById('ingredientFilter').value.trim();
    const company       = companyRaw.toLowerCase();
    const ingredient    = ingredientRaw.toLowerCase();

    // Step 1: Date window + route filter (both immediate, no API)
    let ids = applyRouteFilterToIds(getDateWindowIds());

    // Step 2: Company filter — instant via licenceNumberMap (no enrichment needed)
    if (company) {
        ids = ids.filter(id =>
            (licenceNumberMap[id]?.company_name || '').toLowerCase().includes(company)
        );
    }

    const hasSlowFilter = ingredient || statusFilter;

    if (!hasSlowFilter) {
        filteredIds = ids;
        currentPage = 1;
        await enrichPage();
        renderAll();
        renderPills(companyRaw, ingredientRaw);
        return;
    }

    showLoading(
        statusFilter && !ingredient
            ? `Filtering by status: ${statusFilter}…`
            : 'Searching across products…',
        'This may take a moment'
    );

    try {
        let matchingIds = new Set(ids);

        // Step 3: Ingredient search — fetch per-product ingredient lists and filter client-side.
        // Note: the /medicinalingredient/?ingredientname= API parameter is silently ignored by
        // the Health Canada API; the only supported lookup is by lnhpd_id. We therefore fetch
        // each product's ingredients individually and match locally.
        if (ingredient) {
            const toSearch  = [...matchingIds];
            const needFetch = toSearch.filter(id => ingredientCache[id] === undefined);

            if (needFetch.length > 0) {
                const CONCURRENCY = 30;
                let done = 0;
                for (let i = 0; i < needFetch.length; i += CONCURRENCY) {
                    await Promise.all(needFetch.slice(i, i + CONCURRENCY).map(id => fetchIngredients(id)));
                    done += Math.min(CONCURRENCY, needFetch.length - i);
                    showLoading(
                        `Searching ingredients in ${toSearch.length.toLocaleString()} products…`,
                        `${done.toLocaleString()} of ${needFetch.length.toLocaleString()} fetched`
                    );
                }
            }

            matchingIds = new Set(
                toSearch.filter(id => (ingredientCache[id] || []).some(name => name.includes(ingredient)))
            );
        }

        // Step 4: Status filter — enrich up to 500 unenriched products then apply
        if (statusFilter) {
            const remaining  = [...matchingIds];
            const needEnrich = remaining.filter(id => !enrichedCache[id]).slice(0, 500);
            if (needEnrich.length > 0) {
                for (let i = 0; i < needEnrich.length; i += 15) {
                    await Promise.all(needEnrich.slice(i, i + 15).map(id => fetchLicence(id)));
                }
            }
            matchingIds = new Set(remaining.filter(id => {
                const e = enrichedCache[id];
                return e && e.flag_product_status === statusFilter;
            }));
        }

        filteredIds = allProducts.map(p => p.lnhpd_id).filter(id => matchingIds.has(id));
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
    const routeSel = document.getElementById('routeFilter');
    if (routeSel) routeSel.value = '';
    routeFilter  = '';
    statusFilter = '';
    updateStatusButtons();
    updateQuickChips();
    filteredIds  = getDateWindowIds();
    currentPage  = 1;
    await enrichPage();
    renderAll();
    renderPills('', '');
}

function clearPill(field) {
    if (field === 'routeFilter') {
        routeFilter = '';
        const sel = document.getElementById('routeFilter');
        if (sel) sel.value = '';
        updateQuickChips();
    } else if (field === 'statusFilter') {
        statusFilter = '';
        updateStatusButtons();
        updateQuickChips();
    } else {
        document.getElementById(field).value = '';
    }
    applyFilters();
}

// ── Interactive filter controls ───────────────────────────────────────────────
function setRouteFilter(value) {
    routeFilter = (routeFilter === value) ? '' : value;
    const sel = document.getElementById('routeFilter');
    if (sel) sel.value = routeFilter;
    updateQuickChips();
    applyFilters();
}

async function setStatusFilter(value) {
    statusFilter = (statusFilter === value) ? '' : value;
    updateStatusButtons();
    updateQuickChips();
    await applyFilters();
}

function setQuickFilter(route, status) {
    const sameRoute  = routeFilter  === route;
    const sameStatus = statusFilter === status;
    routeFilter  = (sameRoute  && sameStatus) ? '' : route;
    statusFilter = (sameRoute  && sameStatus) ? '' : status;
    const sel = document.getElementById('routeFilter');
    if (sel) sel.value = routeFilter;
    updateStatusButtons();
    updateQuickChips();
    applyFilters();
}

function onFilterInput() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => applyFilters(), 400);
}

// ── Populate dynamic UI ───────────────────────────────────────────────────────
function populateRouteSelect() {
    const routes = [...new Set(allProducts.map(p => p.route_type_desc).filter(Boolean))].sort();
    const select = document.getElementById('routeFilter');
    if (!select) return;
    select.innerHTML = '<option value="">All routes</option>' +
        routes.map(r => `<option value="${escHtml(r)}">${escHtml(r)}</option>`).join('');
    select.value = routeFilter;
}

function populateQuickFilters() {
    const container = document.getElementById('quickFilters');
    if (!container) return;

    const routeCounts = {};
    allProducts.forEach(p => {
        if (p.route_type_desc) routeCounts[p.route_type_desc] = (routeCounts[p.route_type_desc] || 0) + 1;
    });
    const topRoutes = Object.entries(routeCounts).sort((a, b) => b[1] - a[1]).slice(0, 4);

    window._quickFilters = [
        ...topRoutes.map(([name]) => ({ label: name, route: name, status: '' })),
        { label: '✓ Active only', route: '', status: 'Active'   },
        { label: '✗ Inactive',    route: '', status: 'Inactive' },
    ];

    container.innerHTML = window._quickFilters.map((f, i) =>
        `<button class="quick-chip" id="qchip-${i}" onclick="setQuickFilter('${escHtml(f.route)}','${escHtml(f.status)}')">${escHtml(f.label)}</button>`
    ).join('');
}

function updateStatusButtons() {
    document.querySelectorAll('.status-toggle-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.status === statusFilter);
    });
}

function updateQuickChips() {
    (window._quickFilters || []).forEach((f, i) => {
        const chip = document.getElementById(`qchip-${i}`);
        if (!chip) return;
        chip.classList.toggle('active', f.route === routeFilter && f.status === statusFilter);
    });
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
    enrichPage().then(() => renderAll());
}

function getSortedIds() {
    if (sortKey === 'lnhpd_id') {
        return sortDir === 'desc'
            ? [...filteredIds].sort((a, b) => b - a)
            : [...filteredIds].sort((a, b) => a - b);
    }
    const getSortVal = (id) => {
        if (enrichedCache[id]) return enrichedCache[id][sortKey] || '';
        if (sortKey === 'route_type_desc') return routeIdMap[id] || '';
        return licenceNumberMap[id]?.[sortKey] || '';
    };
    return [...filteredIds].sort((a, b) => {
        const cmp = String(getSortVal(a)).localeCompare(String(getSortVal(b)), undefined, { numeric: true });
        return sortDir === 'asc' ? cmp : -cmp;
    });
}

// ── "New this week" helper ────────────────────────────────────────────────────
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
function isNewThisWeek(id) {
    const date = licenceNumberMap[id]?.licence_date;
    if (!date) return false;
    return Date.now() - new Date(date).getTime() <= WEEK_MS;
}

// ── Rendering ────────────────────────────────────────────────────────────────
function renderAll() {
    renderStats();
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

function renderStats() {
    const bar = document.getElementById('statsBar');
    if (!bar || allProducts.length === 0) { if (bar) bar.style.display = 'none'; return; }
    bar.style.display = 'grid';

    const windowCount   = getDateWindowIds().length;
    const filteredCount = filteredIds.length;
    const pct           = windowCount > 0 ? Math.round(filteredCount / windowCount * 100) : 100;

    const statWindow   = document.getElementById('statWindow');
    const statFiltered = document.getElementById('statFiltered');
    const statDateRange= document.getElementById('statDateRange');

    if (statWindow)   statWindow.textContent   = windowCount.toLocaleString();
    if (statFiltered) statFiltered.textContent = filteredCount.toLocaleString();

    if (statDateRange) {
        const now  = new Date();
        const from = new Date(); from.setDate(now.getDate() - activeDays);
        statDateRange.textContent =
            `${from.toLocaleDateString('en-CA', { month:'short', day:'numeric', year:'numeric' })} – today`;
    }

    const statPct = document.getElementById('statPct');
    if (statPct) {
        statPct.textContent = (filteredCount === windowCount) ? 'all in window' : `${pct}% of window`;
    }

    // Route breakdown — always drawn from the full date window so the chart stays
    // stable regardless of which route filter is active. Selected route is highlighted.
    const windowRoutes = {};
    getDateWindowIds().forEach(id => {
        const r = routeIdMap[id] || 'Unknown';
        windowRoutes[r] = (windowRoutes[r] || 0) + 1;
    });
    const topRoutes = Object.entries(windowRoutes).sort((a, b) => b[1] - a[1]).slice(0, 6);
    const maxCount  = topRoutes[0]?.[1] || 1;
    const routeList = document.getElementById('statRouteList');
    if (routeList) {
        routeList.innerHTML = topRoutes.length
            ? topRoutes.map(([name, count]) => {
                const selected = name === routeFilter;
                const tip = selected ? `Clear route filter` : `Filter by ${escHtml(name)}`;
                return `<div class="route-row${selected ? ' route-row-selected' : ''}" onclick="setRouteFilter(${JSON.stringify(name)})" title="${tip}" style="cursor:pointer">
                    <span class="route-name" title="${escHtml(name)}">${escHtml(name)}</span>
                    <div class="route-bar-track"><div class="route-bar-fill" style="width:${Math.round(count / maxCount * 100)}%"></div></div>
                    <span class="route-count">${count.toLocaleString()}</span>
                </div>`;
              }).join('')
            : '<div class="stat-empty">No data</div>';
    }

    // Status breakdown from enriched cache
    let activeCount = 0, inactiveCount = 0, enrichedTotal = 0;
    filteredIds.forEach(id => {
        const e = enrichedCache[id];
        if (e) {
            enrichedTotal++;
            if (e.flag_product_status === 'Active')   activeCount++;
            if (e.flag_product_status === 'Inactive') inactiveCount++;
        }
    });
    const statStatus = document.getElementById('statStatus');
    if (statStatus) {
        const unloaded   = filteredIds.length - enrichedTotal;
        const loadingAll = _loadingAll;
        const btnLabel   = unloaded > 0
            ? `Load ${unloaded.toLocaleString()} more`
            : `Reload all ${filteredIds.length.toLocaleString()}`;
        const pillsHtml  = enrichedTotal > 0
            ? `<div class="status-pill active-pill" onclick="setStatusFilter('Active')" title="Filter: Active only">` +
              `<span class="dot dot-green"></span>${activeCount.toLocaleString()} active</div>` +
              `<div class="status-pill inactive-pill" onclick="setStatusFilter('Inactive')" title="Filter: Inactive only">` +
              `<span class="dot dot-red"></span>${inactiveCount.toLocaleString()} inactive</div>` +
              `<div class="status-note">of ${enrichedTotal.toLocaleString()} loaded</div>`
            : `<div class="status-note">No records loaded yet</div>`;
        statStatus.innerHTML = pillsHtml +
            `<button id="loadAllBtn" class="load-all-btn" onclick="loadAllFiltered()"${loadingAll ? ' disabled' : ''}>` +
            `${btnLabel}</button>`;
    }
}

let _loadingAll = false;
async function loadAllFiltered() {
    if (_loadingAll) return;
    _loadingAll = true;
    const btn = document.getElementById('loadAllBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }

    const toFetch = filteredIds.filter(id => !enrichedCache[id]);
    const CONCURRENCY = 30;
    let done = 0;

    for (let i = 0; i < toFetch.length; i += CONCURRENCY) {
        await Promise.all(toFetch.slice(i, i + CONCURRENCY).map(id => fetchLicence(id)));
        done += Math.min(CONCURRENCY, toFetch.length - i);
        const b = document.getElementById('loadAllBtn');
        if (b) b.textContent = `Loading… ${done.toLocaleString()} / ${toFetch.length.toLocaleString()}`;
    }

    _loadingAll = false;
    renderStats();
    renderTable();
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

    const sorted  = getSortedIds();
    const start   = (currentPage - 1) * PAGE_SIZE;
    const pageIds = sorted.slice(start, start + PAGE_SIZE);

    const wrapper = document.createElement('div');
    wrapper.className = 'table-wrapper';
    const scroll = document.createElement('div');
    scroll.className = 'table-scroll';
    const table = document.createElement('table');

    const thead    = table.createTHead();
    const headerRow = thead.insertRow();
    COLUMNS.forEach(col => {
        const th    = document.createElement('th');
        th.textContent = col.label;
        th.onclick  = () => toggleSort(col.key);
        if (col.key === sortKey) th.classList.add(sortDir === 'asc' ? 'sort-asc' : 'sort-desc');
        headerRow.appendChild(th);
    });

    const tbody = document.createElement('tbody');
    pageIds.forEach(id => {
        const obj      = enrichedCache[id] || { lnhpd_id: id };
        const row      = tbody.insertRow();
        const isNew    = isNewThisWeek(id);
        if (isNew) row.classList.add('row-new');

        COLUMNS.forEach(col => {
            const td       = row.insertCell();
            if (col.cls) td.className = col.cls;
            const isLoaded = !!enrichedCache[id];

            if (col.key === 'licence_number') {
                const a    = document.createElement('a');
                a.href     = '#';
                a.title    = 'View full product details';
                a.onclick  = e => { e.preventDefault(); openModal(id); };
                if (isLoaded && obj.licence_number !== '—') {
                    a.textContent = obj.licence_number;
                    td.appendChild(a);
                    if (isNew) {
                        const badge = document.createElement('span');
                        badge.className   = 'new-badge';
                        badge.textContent = 'New';
                        td.appendChild(badge);
                    }
                } else if (!isLoaded) {
                    const shimmer = document.createElement('span');
                    shimmer.className = 'cell-loading';
                    td.appendChild(shimmer);
                } else {
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

    const missing = pageIds.filter(id => !enrichedCache[id]);
    if (missing.length > 0) {
        Promise.all(missing.map(id => fetchLicence(id))).then(() => {
            renderTable();
            renderStats();
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
            el.textContent = '…'; el.style.cssText = 'padding:0 4px;color:var(--grey-300)';
            container.appendChild(el);
        }
    }
    for (let p = start; p <= end; p++) container.appendChild(makeBtn(p, p, false, p === currentPage));
    if (end < totalPages) {
        if (end < totalPages - 1) {
            const el = document.createElement('span');
            el.textContent = '…'; el.style.cssText = 'padding:0 4px;color:var(--grey-300)';
            container.appendChild(el);
        }
        container.appendChild(makeBtn(totalPages, totalPages, false, false));
    }
    container.appendChild(makeBtn('→', currentPage + 1, currentPage === totalPages, false));
}

function renderPills(company, ingredient) {
    const container = document.getElementById('activePills');
    container.innerHTML = '';
    const addPill = (label, field) => {
        const pill = document.createElement('div');
        pill.className = 'filter-pill';
        pill.innerHTML = `${escHtml(label)} <button onclick="clearPill('${field}')" title="Remove filter">✕</button>`;
        container.appendChild(pill);
    };
    if (company)      addPill(`Company: ${company}`,       'companyFilter');
    if (ingredient)   addPill(`Ingredient: ${ingredient}`, 'ingredientFilter');
    if (routeFilter)  addPill(`Route: ${routeFilter}`,     'routeFilter');
    if (statusFilter) addPill(`Status: ${statusFilter}`,   'statusFilter');
}

// ── Loading / error states ────────────────────────────────────────────────────
function showLoading(label = 'Loading…', sub = '') {
    document.getElementById('table-container').innerHTML = `
        <div class="loading-state">
            <div class="spinner"></div>
            <span class="loading-label">${escHtml(label)}</span>
            ${sub ? `<span class="loading-sub">${escHtml(sub)}</span>` : ''}
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
    const root    = document.getElementById('modal-root');
    const cached  = enrichedCache[lnhpdId];
    const name    = cached?.product_name || `Product ${lnhpdId}`;
    const licence = cached?.licence_number || lnhpdId;

    root.innerHTML = `
        <div class="modal-backdrop" id="modalBackdrop">
            <div class="modal" role="dialog" aria-modal="true">
                <div class="modal-header">
                    <div>
                        <div class="modal-id">NHP Licence # ${escHtml(String(licence))}</div>
                        <h2>${escHtml(name)}</h2>
                    </div>
                    <button class="modal-close" onclick="closeModal()" aria-label="Close">✕</button>
                </div>
                <div class="modal-body">
                    <div class="modal-loading"><div class="spinner"></div><span>Loading product details…</span></div>
                </div>
            </div>
        </div>`;

    document.getElementById('modalBackdrop').addEventListener('click', e => {
        if (e.target === e.currentTarget) closeModal();
    });
    document._modalEsc = e => { if (e.key === 'Escape') closeModal(); };
    document.addEventListener('keydown', document._modalEsc);

    fetchModalData(lnhpdId).then(html => {
        const body   = document.querySelector('.modal-body');
        if (body) body.innerHTML = html;
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
        const licenceNumber = licenceNumberMap[lnhpdId]?.licence_number;
        const [licenceData, ingredients, nonMedicinal, routes, purposes, risks, dose] = await Promise.all([
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

        const licence  = Array.isArray(licenceData) ? licenceData[0] : licenceData;
        const mapEntry = licenceNumberMap[lnhpdId];
        if (licence) {
            enrichedCache[lnhpdId] = {
                ...enrichedCache[lnhpdId],
                licence_number:           licence.licence_number            || licenceNumber              || '—',
                product_name:             licence.product_name              || mapEntry?.product_name     || '—',
                company_name:             licence.company_name              || mapEntry?.company_name     || '—',
                dosage_form:              licence.dosage_form               || mapEntry?.dosage_form      || '—',
                licence_date:             licence.licence_date              || mapEntry?.licence_date     || '—',
                revised_date:             licence.revised_date              || mapEntry?.revised_date     || '—',
                time_receipt:             licence.time_receipt              || mapEntry?.time_receipt     || '—',
                sub_submission_type_desc: licence.sub_submission_type_desc  || mapEntry?.sub_submission_type_desc || '—',
                flag_product_status:      licence.flag_product_status != null
                    ? (licence.flag_product_status === 1 ? 'Active' : 'Inactive')
                    : (mapEntry?.flag_product_status || '—'),
                _raw: licence,
            };
        }
        return buildModalHTML(licence, ingredients, nonMedicinal, routes, purposes, risks, dose);
    } catch (err) {
        console.error('Modal fetch error:', err);
        return `<div class="modal-error">⚠️ Could not load product details. Please try again.</div>`;
    }
}

function buildModalHTML(licence, ingredients, nonMedicinal, routes, purposes, risks, dose) {
    const toArr   = d => d?.data || (Array.isArray(d) ? d : []);
    const ingArr  = toArr(ingredients);
    const nmArr   = toArr(nonMedicinal);
    const rtArr   = toArr(routes);
    const purArr  = toArr(purposes);
    const riskArr = toArr(risks);
    const doseArr = toArr(dose);

    const field = (label, val) =>
        `<div class="modal-field"><label>${escHtml(label)}</label><span>${escHtml(v(val))}</span></div>`;

    const tbl = (headers, rows, renderRow) =>
        rows.length === 0
            ? '<p style="color:var(--grey-300);font-size:12px;margin:0">None listed</p>'
            : `<table class="modal-table"><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>
               <tbody>${rows.map(renderRow).join('')}</tbody></table>`;

    const statusBadge = licence?.flag_product_status != null
        ? `<span class="badge ${licence.flag_product_status === 1 ? 'badge-active' : 'badge-inactive'}">${licence.flag_product_status === 1 ? 'Active' : 'Inactive'}</span>`
        : '—';

    return `
        <div class="modal-section">
            <div class="modal-section-title">Licence information</div>
            <div class="modal-grid">
                ${field('Product name',      licence?.product_name)}
                ${field('Company',           licence?.company_name)}
                ${field('Licence number',    licence?.licence_number)}
                ${field('Dosage form',       licence?.dosage_form)}
                <div class="modal-field"><label>Status</label><span>${statusBadge}</span></div>
                ${field('Submission type',   licence?.sub_submission_type_desc)}
                ${field('Licence date',      licence?.licence_date)}
                ${field('Date received',     licence?.time_receipt)}
                ${field('Revised date',      licence?.revised_date)}
            </div>
        </div>

        ${rtArr.length ? `
        <div class="modal-section">
            <div class="modal-section-title">Routes of administration</div>
            <div style="display:flex;gap:6px;flex-wrap:wrap">
                ${rtArr.map(r => `<span class="badge" style="background:var(--teal-light);color:var(--teal);border:1px solid rgba(42,127,143,.2)">${escHtml(v(r.route_type_desc))}</span>`).join('')}
            </div>
        </div>` : ''}

        ${purArr.length ? `
        <div class="modal-section">
            <div class="modal-section-title">Recommended use / Purpose</div>
            <div style="font-size:13px;color:var(--grey-900);line-height:1.7">
                ${purArr.map(p => `<p style="margin:0 0 6px">${escHtml(v(p.purpose))}</p>`).join('')}
            </div>
        </div>` : ''}

        <div class="modal-section">
            <div class="modal-section-title">Medicinal ingredients</div>
            ${tbl(
                ['Ingredient', 'Quantity', 'Unit', 'Extract / Potency', 'Source material'],
                ingArr,
                i => {
                    const potency = i.potency_amount
                        ? `${i.potency_amount}${i.potency_unit_of_measure ? ' ' + i.potency_unit_of_measure : ''} ${i.potency_constituent || ''}`.trim()
                        : '—';
                    return `<tr>
                        <td>${escHtml(v(i.ingredient_name))}</td>
                        <td>${escHtml(v(i.quantity))}</td>
                        <td>${escHtml(v(i.quantity_unit_of_measure))}</td>
                        <td>${escHtml(potency)}</td>
                        <td>${escHtml(v(i.source_material))}</td>
                    </tr>`;
                }
            )}
        </div>

        ${nmArr.length ? `
        <div class="modal-section">
            <div class="modal-section-title">Non-medicinal ingredients</div>
            <div style="font-size:13px;color:var(--grey-500);line-height:1.8">
                ${nmArr.map(n => escHtml(v(n.ingredient_name))).join(' · ')}
            </div>
        </div>` : ''}

        ${doseArr.length ? `
        <div class="modal-section">
            <div class="modal-section-title">Dosage</div>
            ${tbl(
                ['Population', 'Quantity', 'Unit', 'Frequency'],
                doseArr,
                d => {
                    const freq = d.frequency
                        ? `${d.frequency}${d.uom_type_desc_frequency ? ' × ' + d.uom_type_desc_frequency : ''}`
                        : (d.frequency_minimum ? `${d.frequency_minimum}–${d.frequency_maximum} ${d.uom_type_desc_frequency || ''}`.trim() : '—');
                    return `<tr>
                        <td>${escHtml(v(d.population_type_desc))}</td>
                        <td>${escHtml(v(d.quantity_dose))}</td>
                        <td>${escHtml(v(d.uom_type_desc_quantity_dose))}</td>
                        <td>${escHtml(freq)}</td>
                    </tr>`;
                }
            )}
        </div>` : ''}

        ${riskArr.length ? `
        <div class="modal-section">
            <div class="modal-section-title">Risks / Cautions</div>
            ${riskArr.map(r => `
                <div style="margin-bottom:8px">
                    ${r.risk_type_desc ? `<div style="font-size:11px;font-weight:600;color:var(--grey-500);text-transform:uppercase;letter-spacing:.06em;margin-bottom:3px">${escHtml(r.risk_type_desc)}</div>` : ''}
                    <div style="font-size:13px;color:var(--grey-900);line-height:1.6">${escHtml(v(r.risk_text))}</div>
                </div>`).join('')}
        </div>` : ''}`;
}

// ── Export ────────────────────────────────────────────────────────────────────
async function exportFilteredSet() {
    if (!filteredIds || filteredIds.length === 0) return;

    const btn          = document.getElementById('downloadBtn');
    const originalText = btn.innerHTML;
    btn.disabled       = true;
    btn.style.opacity  = '0.6';
    btn.innerHTML      = '⏳ Processing...';

    try {
        const missingIds = filteredIds.filter(id => !enrichedCache[id]);
        if (missingIds.length > 0) {
            btn.innerHTML = `⏳ Fetching ${missingIds.length} items...`;
            for (let i = 0; i < missingIds.length; i += 15) {
                await Promise.all(missingIds.slice(i, i + 15).map(id => fetchLicence(id)));
            }
        }

        btn.innerHTML = '✍️ Generating file...';
        const headers = ['Licence Number','Product Name','Company Name','Dosage Form','Route','Licence Date','Status'];
        const esc     = val => { const s = String(val ?? '').replace(/"/g,'""'); return `"${s}"`; };
        const rows    = [headers.join(',')];
        getSortedIds().forEach(id => {
            const item = enrichedCache[id];
            if (item) rows.push([
                esc(item.licence_number), esc(item.product_name), esc(item.company_name),
                esc(item.dosage_form),    esc(item.route_type_desc), esc(item.licence_date),
                esc(item.flag_product_status)
            ].join(','));
        });

        const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8;' });
        const url  = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href     = url;
        link.download = `hc_lnhpd_extract_${activeDays}days.csv`;
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);

    } catch (err) {
        console.error('Export error:', err);
        alert('An error occurred during export. Please try again.');
    } finally {
        btn.disabled      = false;
        btn.style.opacity = '1';
        btn.innerHTML     = originalText;
    }
}

window.addEventListener('load', main);
