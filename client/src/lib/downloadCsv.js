// Client-side CSV export — no dependency, no backend involvement, since
// every current export candidate's data is already loaded in the page
// (or cheaply fetched page-by-page, see fetchAllPages below).

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

// columns: [{ key, label }] — key can be a dotted path ('customer.email')
// or a function (row) => value.
export function downloadCsv(filename, rows, columns) {
  const header = columns.map((c) => csvEscape(c.label)).join(',');
  const lines = rows.map((row) =>
    columns
      .map((c) => {
        const value = typeof c.key === 'function' ? c.key(row) : c.key.split('.').reduce((v, k) => v?.[k], row);
        return csvEscape(value);
      })
      .join(',')
  );
  const csv = [header, ...lines].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// Loops a paginated GET endpoint (api.leads, api.financialEvents, ...)
// until every page is fetched — for exports that need more than the
// single page already loaded in component state.
export async function fetchAllPages(fetchPage, { pageSize = 100, itemsKey } = {}) {
  let page = 1;
  let all = [];
  while (true) {
    const data = await fetchPage(page, pageSize);
    const items = data[itemsKey] || [];
    all = all.concat(items);
    if (items.length < pageSize || all.length >= (data.total ?? Infinity)) break;
    page += 1;
  }
  return all;
}
