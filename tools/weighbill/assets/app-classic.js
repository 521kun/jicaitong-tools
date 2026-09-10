(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const STORE = 'jicaitong-unified-weighbill-ledger-v1';
  const AUTO_START = 18;
  const AUTO_END = 2500;
  const PER_HOUR = 4;
  const NET_MIN_KG = 30000;
  const NET_MAX_KG = 40200;
  const TARE_MIN_KG = 13010;
  const TARE_MAX_KG = 16640;
  const GROSS_MIN_KG = 46100;
  const GROSS_MAX_KG = 55150;
  const HEADERS = ['货物名称', '过磅时间', '车牌号码', '毛重(吨)', '皮重(吨)', '净重(吨)', '数量(立方米)', '单价(元)', '金额(元)'];
  let trips = [];
  let context = null;
  let activeSource = '';

  const pad = (n) => String(Number(n)).padStart(4, '0');
  const dateText = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const timeText = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  const monthText = (d) => dateText(d).slice(0, 7);
  const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
  const money = (value) => Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  const escapeHtml = (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const xmlEscape = escapeHtml;

  function readLocal(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key) || '') || fallback; } catch { return fallback; }
  }

  function parseDate(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      const origin = new Date(1899, 11, 30);
      origin.setSeconds(origin.getSeconds() + Math.round(value * 86400));
      return origin;
    }
    const normalized = String(value || '').trim().replace(/[年/.]/g, '-').replace(/月/g, '-').replace(/日/g, '').replace(/\s+/g, ' ');
    const parsed = new Date(normalized.replace(' ', 'T'));
    if (Number.isNaN(parsed.getTime())) throw Error(`过磅时间“${value}”无法识别。`);
    return parsed;
  }

  function sourceHasTime(value) {
    return /(?:T|\s)\d{1,2}:\d{2}/.test(String(value || ''));
  }

  function allowedTime(value) {
    const d = new Date(value);
    if (d.getHours() < 5) d.setHours(5, d.getMinutes(), d.getSeconds(), 0);
    if (d.getHours() >= 21) { d.setDate(d.getDate() + 1); d.setHours(5, d.getMinutes(), d.getSeconds(), 0); }
    return d;
  }

  function inboundTime(row) {
    const d = allowedTime(row.at);
    if (row.hasTime) return d;
    d.setHours(7 + ((row.rowNo * 3) % 11), 7 + ((row.rowNo * 17) % 50), 10 + ((row.rowNo * 13) % 50), 0);
    return d;
  }

  function outboundTime(inbound, rowNo, minGap, maxGap) {
    const gap = minGap + ((rowNo * 47) % (maxGap - minGap + 1));
    const d = allowedTime(new Date(inbound.getTime() + gap * 60000));
    if (!d.getSeconds()) d.setSeconds(10 + ((rowNo * 13) % 50));
    return d;
  }

  function monthTarget(date) {
    const first = new Date(date.getFullYear(), date.getMonth(), 1);
    const next = new Date(date.getFullYear(), date.getMonth() + 1, 1);
    const progress = Math.max(0, Math.min(1, (date - first) / (next - first)));
    return Math.max(AUTO_START, Math.round(AUTO_START + (AUTO_END - AUTO_START) * progress) - 100);
  }

  function nextFree(used, minimum) {
    for (let n = Math.max(AUTO_START, Math.ceil(minimum)); n <= AUTO_END; n += 1) if (!used.has(n)) return n;
    throw Error('本月可用单号不足。');
  }

  function scheduleMonth(rows, used) {
    const readings = [];
    const times = new Map();
    rows.forEach((row) => {
      const inbound = inboundTime(row);
      const outbound = outboundTime(inbound, row.rowNo, row.minGap, row.maxGap);
      times.set(row.rowNo, { inbound, outbound });
      readings.push({ key: `${row.rowNo}:in`, rowNo: row.rowNo, at: inbound });
      readings.push({ key: `${row.rowNo}:out`, rowNo: row.rowNo, at: outbound });
    });
    readings.sort((a, b) => a.at - b.at || a.rowNo - b.rowNo || a.key.localeCompare(b.key));
    let previousAt = null;
    let previousNumber = null;
    const assigned = new Map();
    readings.forEach((reading) => {
      const byMonth = monthTarget(reading.at);
      const elapsed = previousAt ? Math.max(0, (reading.at - previousAt) / 3600000) : 0;
      // 时间推进只用于“同一时间点内”微调顺序，不允许无限累积顶破月上限。
      // 长间隔后回到以当月时间轴目标为准，保证月末数据也能落回号段内。
      const byTime = previousNumber === null || elapsed >= 1 ? byMonth : previousNumber + Math.max(1, Math.round(elapsed * PER_HOUR));
      const serial = nextFree(used, Math.max(byMonth, byTime));
      used.add(serial);
      assigned.set(reading.key, serial);
      previousAt = reading.at;
      previousNumber = serial;
    });
    return rows.map((row) => {
      const time = times.get(row.rowNo);
      return { rowNo: row.rowNo, inSerial: assigned.get(`${row.rowNo}:in`), outSerial: assigned.get(`${row.rowNo}:out`), inDate: dateText(time.inbound), inTime: timeText(time.inbound), outDate: dateText(time.outbound), outTime: timeText(time.outbound) };
    });
  }

  function scheduleTrips(rows, persistKey = null) {
    const byRow = new Map();
    const grouped = new Map();
    rows.forEach((row) => {
      const month = monthText(row.at);
      if (!grouped.has(month)) grouped.set(month, []);
      grouped.get(month).push(row);
    });
    const ledger = persistKey ? readLocal(STORE, {}) : {};
    grouped.forEach((monthRows, month) => {
      const monthLedger = ledger[month] || { batches: {} };
      let records = persistKey ? monthLedger.batches[persistKey]?.records : null;
      if (!records || records.length !== monthRows.length) {
        const used = new Set();
        Object.entries(monthLedger.batches).forEach(([key, batch]) => {
          if (key !== persistKey) (batch.records || []).forEach((record) => { used.add(record.inSerial); used.add(record.outSerial); });
        });
        records = scheduleMonth(monthRows, used);
        if (persistKey) monthLedger.batches[persistKey] = { records };
      }
      records.forEach((record) => byRow.set(record.rowNo, { ...record, month }));
      ledger[month] = monthLedger;
    });
    if (persistKey) localStorage.setItem(STORE, JSON.stringify(ledger));
    return rows.map((row, index) => ({ no: index + 1, ...row, ...byRow.get(row.rowNo) }));
  }

  function ticketFields(trip, kind) {
    // 单张称重单只记录本次过磅值：满车或空车都写入毛重/净重，皮重固定为 0。
    // 业务净重仅在报单和 Excel 中按“满车 − 空车”保存，绝不写成单张称重单的重量。
    const weight = kind === 'full' ? trip.gross : trip.tare;
    return { gross: weight, tare: 0, net: weight };
  }

  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

  function generatedTare(rowNo, net) {
    // 由已提供的真实磅单取值：重车 46.10–55.15 吨、空车 13.01–16.64 吨、净重 30.00–40.20 吨。
    // 先确定净重，再在真实重车区间内反推空车值，避免“随机皮重 + 净重”造出不合理满车重量。
    const lowGross = Math.max(GROSS_MIN_KG, net + TARE_MIN_KG);
    const highGross = Math.min(GROSS_MAX_KG, net + TARE_MAX_KG);
    if (lowGross > highGross) throw Error(`净重 ${net / 1000} 吨无法匹配样本中的满车、空车范围。`);
    const desiredGross = 50500 + (((Number(rowNo) * 173) % 61) - 30) * 90;
    const gross = Math.round(clamp(desiredGross, lowGross, highGross));
    return gross - net;
  }

  function distributeNetWeights(totalKg, count) {
    if (totalKg < count * NET_MIN_KG || totalKg > count * NET_MAX_KG) throw Error('总净重无法在样本净重范围内分配。');
    const weights = Array.from({ length: count }, (_, index) => {
      const offset = (((index * 137) % 29) - 14) * 70;
      return clamp(Math.round((totalKg / count + offset) / 10) * 10, NET_MIN_KG, NET_MAX_KG);
    });
    let difference = totalKg - weights.reduce((sum, value) => sum + value, 0);
    while (difference !== 0) {
      let changed = false;
      for (let index = 0; index < weights.length && difference !== 0; index += 1) {
        const room = difference > 0 ? NET_MAX_KG - weights[index] : weights[index] - NET_MIN_KG;
        if (!room) continue;
        const remaining = weights.length - index;
        const step = Math.min(Math.abs(difference), room, Math.max(1, Math.ceil(Math.abs(difference) / remaining)));
        weights[index] += Math.sign(difference) * step;
        difference -= Math.sign(difference) * step;
        changed = true;
      }
      if (!changed) throw Error('净重分配失败。');
    }
    return weights;
  }

  function distributeVolume(totalVolume, count) {
    if (totalVolume === '') return Array(count).fill('');
    const total = Math.round(Number(totalVolume) * 1000);
    if (!Number.isFinite(total) || total < 0) throw Error('立方米总数量填写无效。');
    const base = Math.floor(total / count);
    return Array.from({ length: count }, (_, index) => (index === count - 1 ? total - base * (count - 1) : base) / 1000);
  }

  function planPrices(weights, basePrice, range, targetAmount) {
    const prices = Array(weights.length).fill(basePrice);
    const cents = (weight, unitPrice) => Math.round(weight / 1000 * unitPrice * 100);
    const baseline = weights.reduce((sum, weight) => sum + cents(weight, basePrice), 0);
    const target = Math.round(targetAmount * 100);
    const needed = target - baseline;
    if (!needed) return prices;
    if (!range) throw Error('当前总金额无法用固定单价精确闭合；请把“优先调价范围”设为至少 1 元。');

    // 金额优先于单价：优先保留整数单价；确有必要时，只让最少的行在允许范围内使用一位小数。
    const candidates = [];
    const adjustmentTenths = Math.min(range * 10, 10);
    weights.forEach((weight, row) => {
      for (let tenth = -adjustmentTenths; tenth <= adjustmentTenths; tenth += 1) {
        if (!tenth || basePrice + tenth / 10 < 0) continue;
        candidates.push({ row, tenth, change: cents(weight, basePrice + tenth / 10) - cents(weight, basePrice), cost: Math.abs(tenth) });
      }
    });
    const choose = (plans) => plans && plans.reduce((sum, item) => sum + item.cost, 0);
    let answer = candidates.filter((item) => item.change === needed).sort((a, b) => a.cost - b.cost)[0] || null;
    const singleCost = answer ? answer.cost : Infinity;
    const byChange = new Map();
    for (let left = 0; left < candidates.length; left += 1) {
      for (let right = left + 1; right < candidates.length; right += 1) {
        const a = candidates[left]; const b = candidates[right];
        if (a.row === b.row) continue;
        const key = a.change + b.change;
        const prior = byChange.get(key);
        if (!prior || a.cost + b.cost < prior.cost) byChange.set(key, { items: [a, b], cost: a.cost + b.cost });
      }
    }
    const pair = byChange.get(needed);
    if (pair && pair.cost < singleCost) answer = pair.items;
    else if (answer) answer = [answer];
    if (!answer) {
      let best = null;
      candidates.forEach((item) => {
        const pairPlan = byChange.get(needed - item.change);
        if (!pairPlan || pairPlan.items.some((other) => other.row === item.row)) return;
        const plan = [item, ...pairPlan.items]; const cost = choose(plan);
        if (!best || cost < best.cost) best = { plan, cost };
      });
      answer = best?.plan || null;
    }
    if (!answer) throw Error('在当前调价范围内无法把总金额精确配平；请增大“优先调价范围”。');
    answer.forEach(({ row, tenth }) => { prices[row] = basePrice + tenth / 10; });
    const actual = weights.reduce((sum, weight, index) => sum + cents(weight, prices[index]), 0);
    if (actual !== target) throw Error('单价配平校验失败。');
    return prices;
  }

  function ticketRows() {
    return trips.flatMap((trip) => [[trip, 'full', trip.inSerial, trip.inDate, trip.inTime], [trip, 'empty', trip.outSerial, trip.outDate, trip.outTime]]);
  }

  function ticketMarkup(trip, kind, serial, date, time) {
    const fields = ticketFields(trip, kind);
    return `<section class="ticket"><h2>称  重  单</h2><div>序号<strong>${pad(serial)}</strong></div><div>日期<strong>${date}</strong></div><div>时间<strong>${time}</strong></div><div>车号<strong>000000</strong></div><div>毛重<strong>${fields.gross}kg</strong></div><div>皮重<strong>${fields.tare}kg</strong></div><div>净重<strong>${fields.net}kg</strong></div></section>`;
  }

  function render(priceLabel) {
    const totalKg = trips.reduce((sum, trip) => sum + trip.net, 0);
    const totalAmount = trips.reduce((sum, trip) => sum + trip.amount, 0);
    const slips = ticketRows();
    $('kpis').innerHTML = `<div class="kpi"><span>采用单价</span><b>${escapeHtml(priceLabel)}</b></div><div class="kpi"><span>车辆数量</span><b>${trips.length} 辆</b></div><div class="kpi"><span>总净重</span><b>${money(totalKg / 1000)} 吨</b></div><div class="kpi"><span>核算金额</span><b>${money(totalAmount)} 元</b></div>`;
    $('resultTable').innerHTML = `<table><thead><tr><th>车次</th><th>重车号</th><th>空车号</th><th>重车时间</th><th>空车时间</th><th>净重(kg)</th></tr></thead><tbody>${trips.map((trip) => `<tr><td>${trip.no}</td><td>${pad(trip.inSerial)}</td><td>${pad(trip.outSerial)}</td><td>${trip.inDate} ${trip.inTime}</td><td>${trip.outDate} ${trip.outTime}</td><td>${trip.net}</td></tr>`).join('')}</tbody></table>`;
    const preview = slips.map(([trip, kind, serial, date, time]) => `<div class="ticket-page">${ticketMarkup(trip, kind, serial, date, time)}</div>`).join('');
    $('formPreview').classList.remove('empty');
    $('formPreview').innerHTML = preview;
    $('printArea').innerHTML = preview;
    ['printPdf', 'directPrintPdf', 'importPrintPdf'].forEach((id) => { $(id).disabled = !trips.length; });
    const canExportTable = Boolean(context && trips.length);
    ['testDownloadSimple', 'directDownloadSimple', 'importDownloadSimple', 'testDownloadLedger', 'directDownloadLedger', 'importDownloadLedger'].forEach((id) => { $(id).disabled = !canExportTable; });
  }

  async function loadTemplateBytes() {
    try {
      const response = await fetch('assets/57mm-weighbill-blank-template.pdf');
      if (!response.ok) throw Error('PDF 模板读取失败。');
      return await response.arrayBuffer();
    } catch (error) {
      if (window.__WEIGHBILL_TEMPLATE_B64) {
        const binary = atob(window.__WEIGHBILL_TEMPLATE_B64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        return bytes.buffer;
      }
      throw error;
    }
  }

  async function downloadPdf() {
    if (!trips.length) return;
    const template = await loadTemplateBytes();
    const source = await PDFDocument.load(template);
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.TimesRoman);
    const right = 143.15;
    const y = [128.9, 110.4, 91.9, 73.4, 54.9, 36.4, 17.9];
    for (const [trip, kind, serial, date, time] of ticketRows()) {
      const [page] = await pdf.copyPages(source, [0]);
      const fields = ticketFields(trip, kind);
      const values = [pad(serial), date, time, '000000', `${fields.gross}kg`, `${fields.tare}kg`, `${fields.net}kg`];
      pdf.addPage(page);
      values.forEach((value, index) => {
        page.drawRectangle({ x: 64, y: y[index] - 3, width: 92, height: 18, color: rgb(1, 1, 1) });
        page.drawText(value, { x: right - font.widthOfTextAtSize(value, 16), y: y[index], size: 16, font, color: rgb(0, 0, 0) });
      });
    }
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([await pdf.save()], { type: 'application/pdf' }));
    link.download = `${activeSource || '称重单'}_统一模板.pdf`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1500);
  }

  function xlsxValue(cell, shared) {
    const type = cell.getAttribute('t');
    const value = cell.getElementsByTagName('v')[0]?.textContent || cell.getElementsByTagName('is')[0]?.textContent || '';
    if (type === 's') return shared[Number(value)] || '';
    return value !== '' && Number.isFinite(Number(value)) ? Number(value) : value;
  }

  async function readImportRows(file) {
    const zip = await JSZip.loadAsync(file);
    const sheet = zip.file('xl/worksheets/sheet1.xml');
    if (!sheet) throw Error('未找到第一个工作表。');
    const parser = new DOMParser();
    const sharedFile = zip.file('xl/sharedStrings.xml');
    const shared = sharedFile ? Array.from(parser.parseFromString(await sharedFile.async('string'), 'application/xml').getElementsByTagName('si')).map((node) => node.textContent) : [];
    const xml = parser.parseFromString(await sheet.async('string'), 'application/xml');
    const rows = Array.from(xml.getElementsByTagName('row')).map((row) => {
      const values = {};
      Array.from(row.getElementsByTagName('c')).forEach((cell) => { values[(cell.getAttribute('r').match(/[A-Z]+/) || [''])[0]] = xlsxValue(cell, shared); });
      return values;
    });
    const columns = {};
    Object.entries(rows[0] || {}).forEach(([column, value]) => { columns[String(value).trim()] = column; });
    const missing = HEADERS.filter((header) => !columns[header]);
    if (missing.length) throw Error(`表头不匹配，缺少：${missing.join('、')}`);
    return rows.slice(1).filter((row) => Object.values(row).some((value) => value !== '')).map((row, index) => {
      const get = (header) => row[columns[header]];
      const rowNo = index + 2;
      const rawTime = get('过磅时间');
      const gross = Math.round(Number(get('毛重(吨)')) * 1000);
      const tare = Math.round(Number(get('皮重(吨)')) * 1000);
      const net = Math.round(Number(get('净重(吨)')) * 1000);
      const rawQuantity = get('数量(立方米)');
      const quantity = rawQuantity === '' || rawQuantity === undefined || rawQuantity === null ? '' : Number(rawQuantity);
      const price = Number(get('单价(元)'));
      const amount = Number(get('金额(元)'));
      if (![gross, tare, net, price, amount].every(Number.isFinite) || (quantity !== '' && (!Number.isFinite(quantity) || quantity < 0))) throw Error(`第 ${rowNo} 行有无法识别的数字。`);
      if (gross - tare !== net) throw Error(`第 ${rowNo} 行重量不一致：毛重－皮重不等于净重。`);
      if (Math.abs(round2(net / 1000 * price) - amount) > .011) throw Error(`第 ${rowNo} 行金额与“净重 × 单价”不一致。`);
      return { rowNo, goods: String(get('货物名称') || '').trim(), plate: String(get('车牌号码') || '').trim(), at: parseDate(rawTime), hasTime: sourceHasTime(rawTime), gross, tare, net, quantity, price, amount };
    });
  }

  function columnName(index) {
    let value = index + 1;
    let out = '';
    while (value) { const r = (value - 1) % 26; out = String.fromCharCode(65 + r) + out; value = Math.floor((value - 1) / 26); }
    return out;
  }

  function downloadWorkbook(name, sheets) {
    const zip = new JSZip();
    const sheetXml = (rows) => `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.map((row, ri) => `<row r="${ri + 1}">${row.map((value, ci) => `<c r="${columnName(ci)}${ri + 1}" t="inlineStr"><is><t>${xmlEscape(value)}</t></is></c>`).join('')}</row>`).join('')}</sheetData></worksheet>`;
    zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`);
    zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
    zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((sheet, i) => `<sheet name="${xmlEscape(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`);
    zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`);
    sheets.forEach((sheet, index) => zip.file(`xl/worksheets/sheet${index + 1}.xml`, sheetXml(sheet.rows)));
    return zip.generateAsync({ type: 'blob' }).then((blob) => {
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob); link.download = name; link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1500);
    });
  }

  function buildDirect() {
    const entries = $('directEntries').value.split(/\r?\n/).map((line, index) => ({ index: index + 1, cells: line.trim() ? line.trim().split(/[,，\t\s]+/) : [] })).filter((row) => row.cells.length);
    if (!entries.length) throw Error('请至少填写一行日期和净重。');
    const goods = $('directGoods').value.trim() || '原木';
    const price = Number($('directPrice').value);
    const plate = $('directPlate').value.trim();
    if (!Number.isFinite(price) || price < 0) throw Error('直接制作的单价填写无效。');
    const rows = entries.map((entry, index) => {
      if (entry.cells.length !== 2 && entry.cells.length !== 3) throw Error(`第 ${entry.index} 行请填写日期、净重和可选数量。`);
      const net = Math.round(Number(entry.cells[1]) * 1000);
      if (!Number.isFinite(net) || net < NET_MIN_KG || net > NET_MAX_KG) throw Error(`第 ${entry.index} 行净重应在 ${NET_MIN_KG / 1000}–${NET_MAX_KG / 1000} 吨之间。`);
      const quantity = entry.cells.length === 3 ? Number(entry.cells[2]) : '';
      if (quantity !== '' && (!Number.isFinite(quantity) || quantity < 0)) throw Error(`第 ${entry.index} 行立方米数量无效。`);
      const rawDate = entry.cells[0];
      const tare = generatedTare(index + 1, net);
      return { rowNo: index + 1, goods, plate, at: parseDate(rawDate), hasTime: sourceHasTime(rawDate), net, gross: net + tare, tare, quantity, price, amount: round2(net / 1000 * price), minGap: 120, maxGap: 360 };
    });
    trips = scheduleTrips(rows);
    context = { rows, months: [...new Set(rows.map((row) => monthText(row.at)))], fileName: '直接制作' }; activeSource = '直接制作'; render(`${money(price)} 元/吨`);
    $('directStatus').textContent = `已生成 ${trips.length} 车、${trips.length * 2} 张统一模板称重单；PDF、简化开票表和业务台账均可下载。`;
  }

  function buildTest() {
    const amount = Number($('total').value);
    const price = Number($('price').value);
    const priceRange = Number($('priceRange').value);
    const totalVolume = $('testVolume').value.trim();
    const start = $('startDate').value;
    const end = $('endDate').value;
    const daily = Number($('dailyMax').value);
    if (!amount || !price || !Number.isInteger(priceRange) || priceRange < 0 || !start || !end || daily < 1 || daily > 4) throw Error('请填写有效的测试条件。');
    const totalKg = Math.round(amount * 1000 / price);
    // 净重先决定最低车数：任何一车都不允许超过真实样本的净重上限。
    const count = Math.max(1, Math.ceil(totalKg / NET_MAX_KG));
    const startDate = new Date(`${start}T08:00:00`);
    const endDate = new Date(`${end}T18:00:00`);
    const spanDays = Math.max(1, Math.floor((endDate - startDate) / 86400000) + 1);
    if (count > spanDays * daily) throw Error('日期范围容纳不下该测试车辆数。');
    const netWeights = distributeNetWeights(totalKg, count);
    const volumes = distributeVolume(totalVolume, count);
    const prices = planPrices(netWeights, price, priceRange, amount);
    const rows = Array.from({ length: count }, (_, index) => {
      const at = new Date(startDate);
      // 起止日期是排期范围，不只是容量校验：整段期间均匀安排，且每天绝不超过 daily 车。
      // 车辆数不超过天数时，第一车落在开始日、最后一车落在结束日；车辆数更多时按天均衡装载。
      const dayOffset = count <= spanDays
        ? (count === 1 ? 0 : Math.round(index * (spanDays - 1) / (count - 1)))
        : Math.floor(index * spanDays / count);
      at.setDate(at.getDate() + dayOffset);
      at.setHours(7 + ((index * 3) % 11), 9 + ((index * 19) % 45), 11 + ((index * 17) % 45));
      const net = netWeights[index];
      const tare = generatedTare(index + 1, net);
      const rowPrice = prices[index];
      return { rowNo: index + 1, goods: '原木', plate: '', at, hasTime: true, gross: net + tare, tare, net, quantity: volumes[index], price: rowPrice, amount: round2(net / 1000 * rowPrice), minGap: 120, maxGap: 360 };
    });
    trips = scheduleTrips(rows);
    context = { rows, months: [...new Set(rows.map((row) => monthText(row.at)))], fileName: '测试安排' }; activeSource = '测试安排'; render(`${money(price)} 元/吨`);
    const actualAmount = round2(rows.reduce((sum, row) => sum + row.amount, 0));
    if (Math.round(actualAmount * 100) !== Math.round(amount * 100)) throw Error('总金额精确校验失败。');
    $('status').textContent = `已生成 ${trips.length} 车；PDF、简化开票表和业务台账均可下载。核算金额 ${money(actualAmount)} 元，与目标金额一致。`;
  }

  async function buildImport() {
    const file = $('importFile').files[0];
    if (!file) throw Error('请先选择 Excel 文件。');
    const minGap = Number($('emptyGapMin').value);
    const maxGap = Number($('emptyGapMax').value);
    if (!Number.isInteger(minGap) || !Number.isInteger(maxGap) || minGap < 1 || maxGap < minGap) throw Error('空车间隔填写无效。');
    const rows = await readImportRows(file);
    const months = [...new Set(rows.map((row) => monthText(row.at)))].sort();
    const requested = $('importMonth').value;
    if (requested && (months.length !== 1 || requested !== months[0])) throw Error(`业务月份与导入数据不一致：${months.join('、')}。`);
    rows.forEach((row) => { row.minGap = minGap; row.maxGap = maxGap; });
    trips = scheduleTrips(rows, `${file.name}|${file.size}|${file.lastModified}`);
    context = { rows, months, fileName: file.name };
    activeSource = 'import';
    const prices = [...new Set(rows.map((row) => row.price))];
    render(prices.length === 1 ? `${money(prices[0])} 元/吨` : '按导入表');
    $('importStatus').textContent = `已校验 ${trips.length} 条；全部 PDF 已统一使用同一模板和时间轴编号规则。`;
  }

  function exportSimple() {
    if (!context) return;
    downloadWorkbook(`${activeSource || '称重单'}_简化开票表.xlsx`, [{ name: '简化开票表', rows: [HEADERS, ...context.rows.map((row) => [row.goods, `${dateText(row.at)} ${timeText(row.at).slice(0, 5)}`, row.plate, row.gross / 1000, row.tare / 1000, row.net / 1000, row.quantity, row.price, row.amount.toFixed(2)])] }]);
  }

  function exportLedger() {
    if (!context) return;
    const rows = [['业务月份', '来源行', '重车号', '空车号', '重车时间', '空车时间', '毛重kg', '皮重kg', '净重kg'], ...trips.map((trip) => [trip.month, trip.rowNo, pad(trip.inSerial), pad(trip.outSerial), `${trip.inDate} ${trip.inTime}`, `${trip.outDate} ${trip.outTime}`, trip.gross, trip.tare, trip.net])];
    downloadWorkbook(`${activeSource || '称重单'}_业务台账.xlsx`, [{ name: '业务台账', rows }]);
  }

  $('generate').onclick = () => { try { buildTest(); } catch (error) { $('status').textContent = error.message; } };
  $('directGenerate').onclick = () => { try { buildDirect(); } catch (error) { $('directStatus').textContent = error.message; } };
  $('importGenerate').onclick = async () => {
    const button = $('importGenerate');
    button.disabled = true; button.textContent = '正在导入…';
    try { await buildImport(); } catch (error) { $('importStatus').textContent = error.message; }
    finally { button.disabled = false; button.textContent = '导入、校验并生成'; }
  };
  ['printPdf', 'directPrintPdf', 'importPrintPdf'].forEach((id) => { $(id).onclick = () => downloadPdf().catch((error) => { $('importStatus').textContent = error.message; }); });
  ['testDownloadSimple', 'directDownloadSimple', 'importDownloadSimple'].forEach((id) => { $(id).onclick = exportSimple; });
  ['testDownloadLedger', 'directDownloadLedger', 'importDownloadLedger'].forEach((id) => { $(id).onclick = exportLedger; });

  const today = new Date();
  const end = new Date(today); end.setDate(end.getDate() + 30);
  $('startDate').value = dateText(today);
  $('endDate').value = dateText(end);
})();
