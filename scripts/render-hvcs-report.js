#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const REPORTS_DIR = path.join(ROOT, "reports");
const args = process.argv.slice(2);

function opt(name) {
  const eq = args.find((arg) => arg.startsWith(name + "="));
  if (eq) return eq.slice(name.length + 1);
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : "";
}

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}

function num(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number(String(value ?? "").replace(/,/g, "").replace(/kW/gi, "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function fmt(value, digits = 0) {
  const n = num(value);
  if (n == null) return "-";
  return n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function readJson(file, label) {
  if (!file || !fs.existsSync(file)) throw new Error(`${label} not found: ${file}`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function flattenObjects(value, out = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => flattenObjects(item, out));
    return out;
  }
  if (!value || typeof value !== "object") return out;
  const entries = Object.entries(value);
  if (entries.length && entries.every(([, item]) => item == null || typeof item !== "object")) out.push(value);
  entries.forEach(([, item]) => flattenObjects(item, out));
  return out;
}

function findValueByKeyPattern(payload, patterns) {
  for (const row of flattenObjects(payload.basic || payload)) {
    for (const [key, value] of Object.entries(row)) {
      if (patterns.some((pattern) => pattern.test(key))) return value;
    }
  }
  return "";
}

function findContractKw(payload) {
  for (const row of flattenObjects(payload.basic || payload)) {
    for (const [key, value] of Object.entries(row)) {
      if (/契約容量|contract/i.test(key)) {
        const parsed = num(value);
        if (parsed != null && parsed > 0) return parsed;
      }
    }
  }
  return null;
}

const BILL_KEYS = {
  month: "\u96fb\u8cbb\u6708\u4efd",
  period: "\u8a08\u8cbb\u671f\u9593",
  basicFee: "\u57fa\u672c\u96fb\u8cbb_\u7d04\u5b9a",
  energyFee: "\u6d41\u52d5\u96fb\u8cbb",
  basicFee2: "\u57fa\u672c\u96fb\u8cbb_\u7d04\u5b9a_2",
  powerFactor: "\u529f\u7387\u56e0\u6578",
  powerFactorAdjustment: "\u529f\u7387\u56e0\u6578\u8abf\u6574\u8cbb",
  otherAdjustment: "\u52a0\u6e1b\u6536\u9805\u91d1\u984d_\u5099\u8a3b",
  total: "\u7e3d\u984d",
  subtotal: "\u5408\u8a08",
};

function billRows(payload) {
  return flattenObjects(payload.price || [])
    .filter((row) => Object.values(row).some((value) => /\d{2,4}\/\d{1,2}\/\d{1,2}\s*~/.test(String(value || ""))) || String(row[BILL_KEYS.month] || "").includes(BILL_KEYS.subtotal))
    .map((row) => ({
      month: String(row[BILL_KEYS.month] || ""),
      period: String(row[BILL_KEYS.period] || ""),
      basicFee: num(row[BILL_KEYS.basicFee]),
      energyFee: num(row[BILL_KEYS.energyFee]),
      basicFee2: num(row[BILL_KEYS.basicFee2]),
      powerFactor: num(row[BILL_KEYS.powerFactor]),
      powerFactorAdjustment: num(row[BILL_KEYS.powerFactorAdjustment]),
      otherAdjustment: num(row[BILL_KEYS.otherAdjustment]),
      total: num(row[BILL_KEYS.total]),
      raw: row,
    }));
}


const TOU = {
  offPeak: "\u96e2\u5cf0",
  halfPeak: "\u534a\u5c16\u5cf0",
  saturdayHalfPeak: "\u9031\u516d\u534a\u5c16\u5cf0",
  peak: "\u5c16\u5cf0",
  contract: "\u5951\u7d04",
};

function isContractCategory(category) {
  const text = String(category || "");
  return text.includes(TOU.contract) || /contract/i.test(text);
}

function isAuthenticatedLoadCategory(category) {
  const text = String(category || "");
  if (!text || isContractCategory(text)) return false;
  return [TOU.offPeak, TOU.halfPeak, TOU.saturdayHalfPeak, TOU.peak].some((name) => text.includes(name));
}

function daySeriesByTime(day) {
  const byTime = new Map();
  const categoryByTime = new Map();
  const categoryCountByTime = new Map();
  const contractValues = [];
  const rejectedCategories = new Set();

  for (const series of day.series || []) {
    const category = String(series.category || "unknown");
    if (isContractCategory(category)) {
      for (const point of series.series_data || []) {
        const v = num(point.value);
        if (v != null) contractValues.push(v);
      }
      continue;
    }
    if (!isAuthenticatedLoadCategory(category)) {
      rejectedCategories.add(category);
      continue;
    }

    for (const point of series.series_data || []) {
      const value = num(point.value);
      if (value == null) continue;
      categoryCountByTime.set(point.time, (categoryCountByTime.get(point.time) || 0) + 1);
      const current = categoryByTime.get(point.time);
      if (!current || value > current.value) {
        categoryByTime.set(point.time, { category, value });
        byTime.set(point.time, value);
      }
    }
  }

  const points = Array.from(byTime.entries()).map(([time, value]) => ({
    time,
    value,
    tou: categoryByTime.get(time)?.category || TOU.offPeak,
  }));
  const actualCategories = new Set(points.map((point) => point.tou).filter(Boolean));
  const peak = points.reduce((best, point) => point.value > best.value ? point : best, { time: "", value: 0 });
  return {
    points,
    actualCategories,
    rejectedCategories,
    overlappingTouSlotCount: Array.from(categoryCountByTime.values()).filter((count) => count > 1).length,
    contractSampleCount: contractValues.length,
    contractMaxKw: contractValues.length ? Math.max(...contractValues) : null,
    peakKw: peak.value,
    peakTime: peak.time,
    totalKwh: points.reduce((sum, point) => sum + point.value * 0.25, 0),
    contract: contractValues.length ? Math.max(...contractValues) : null,
  };
}

function dailyRows(range) {
  const daily = Array.isArray(range.daily) ? range.daily : Object.values(range.daily || {});
  return daily.map((day) => {
    const date = String(day?.target_date?.gregorian || "").replaceAll("/", "-");
    return { date, ...daySeriesByTime(day) };
  });
}

function isSummer(dateText) {
  const match = dateText.match(/^\d{4}-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const key = Number(`${match[1]}${match[2]}`);
  return key >= 516 && key <= 1015;
}

function isOffPeakDayFromHvcs(row) {
  const categories = Array.from(row.actualCategories || []).filter(Boolean);
  return categories.length > 0 && categories.every((category) => String(category).includes(TOU.offPeak));
}

function dayBucket(row) {
  return `${isSummer(row.date) ? "summer" : "non_summer"}_${isOffPeakDayFromHvcs(row) ? "offpeak" : "working"}`;
}

function averageProfile(rows) {
  const buckets = new Map();
  for (const row of rows) for (const p of row.points) {
    const bucket = buckets.get(p.time) || { sum: 0, count: 0 };
    bucket.sum += p.value;
    bucket.count += 1;
    buckets.set(p.time, bucket);
  }
  return Array.from(buckets.entries()).map(([time, b]) => ({ x: time, y: b.count ? b.sum / b.count : 0 }));
}

function profileTouBands(rows) {
  const byTime = new Map();
  for (const row of rows) for (const p of row.points) {
    const bucket = byTime.get(p.time) || new Map();
    bucket.set(p.tou, (bucket.get(p.tou) || 0) + Math.max(1, p.value));
    byTime.set(p.time, bucket);
  }
  const times = rows[0]?.points.map((p) => p.time) || [];
  return times.map((time) => {
    const votes = byTime.get(time) || new Map();
    let best = "離峰";
    let bestValue = -1;
    for (const [category, value] of votes.entries()) {
      if (value > bestValue) { best = category; bestValue = value; }
    }
    return { time, category: best };
  });
}

function colorForCategory(category) {
  const text = String(category || "");
  if (text.includes(TOU.peak) && !text.includes(TOU.halfPeak)) return "#fee2e2";
  if (text.includes(TOU.saturdayHalfPeak)) return "#ffedd5";
  if (text.includes(TOU.halfPeak)) return "#fef3c7";
  if (text.includes(TOU.offPeak)) return "#dcfce7";
  return "#eef2f7";
}

function defaultTickIndices(count, maxTicks = 8) {
  if (count <= 0) return [];
  if (count === 1) return [0];
  const last = count - 1;
  const step = Math.max(1, Math.ceil(last / Math.max(1, maxTicks - 1)));
  const ticks = [];
  for (let i = 0; i < count; i += step) ticks.push(i);
  if (ticks[ticks.length - 1] !== last) ticks.push(last);
  return ticks;
}

function timeTickIndices(points, hourStep = 4) {
  const ticks = [];
  for (let i = 0; i < points.length; i += 1) {
    const label = String(points[i]?.x || points[i]?.time || "");
    const match = label.match(/^(\d{1,2}):(\d{2})$/);
    if (!match) continue;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (minute === 0 && hour % hourStep === 0) ticks.push(i);
  }
  if (!ticks.includes(0)) ticks.unshift(0);
  if (points.length && !ticks.includes(points.length - 1)) ticks.push(points.length - 1);
  return Array.from(new Set(ticks)).sort((a, b) => a - b);
}

function xTickObjects(points, maxTicks = 10) {
  return defaultTickIndices(points.length, maxTicks).map((index) => ({ index, label: points[index]?.x || points[index]?.date || "" }));
}

function xTickLabels(width, height, left, right, count, ticks, y, rotate = false) {
  return ticks.map((tick) => {
    const denom = Math.max(1, count - 1);
    const x = left + (tick.index * (width - left - right)) / denom;
    if (rotate) return `<text x="${x.toFixed(1)}" y="${y}" text-anchor="end" transform="rotate(-35 ${x.toFixed(1)} ${y})">${esc(tick.label)}</text>`;
    return `<text x="${x.toFixed(1)}" y="${y}" text-anchor="middle">${esc(tick.label)}</text>`;
  }).join("");
}
function axes(width, height, left, right, top, bottom, max, xCount, xTicks = []) {
  let out = "";
  for (let i = 0; i <= 4; i += 1) {
    const y = top + i * (height - top - bottom) / 4;
    const value = max * (1 - i / 4);
    out += `<line class="grid" x1="${left}" y1="${y.toFixed(1)}" x2="${width-right}" y2="${y.toFixed(1)}"/>`;
    out += `<text x="8" y="${(y + 4).toFixed(1)}">${fmt(value, 0)}</text>`;
  }
  const ticks = xTicks.length ? xTicks : defaultTickIndices(xCount, 8).map((index) => ({ index, label: "" }));
  for (const tick of ticks) {
    const x = left + (tick.index * (width - left - right)) / Math.max(1, xCount - 1);
    out += `<line class="grid" x1="${x.toFixed(1)}" y1="${top}" x2="${x.toFixed(1)}" y2="${height-bottom}"/>`;
  }
  out += `<line class="axis" x1="${left}" y1="${height-bottom}" x2="${width-right}" y2="${height-bottom}"/>`;
  out += `<line class="axis" x1="${left}" y1="${top}" x2="${left}" y2="${height-bottom}"/>`;
  return out;
}

function contractExceedances(rows, contractKw) {
  if (!contractKw) return { points: [], sampleCount: 0, dayCount: 0, maxKw: null, maxExcessKw: null, excessKwh: 0, top: [] };
  const points = [];
  for (const row of rows) {
    for (const p of row.points || []) {
      if (p.value > contractKw) {
        points.push({ date: row.date, time: p.time, kw: p.value, tou: p.tou, excess_kw: p.value - contractKw });
      }
    }
  }
  points.sort((a, b) => b.excess_kw - a.excess_kw || b.kw - a.kw || String(a.date).localeCompare(String(b.date)) || String(a.time).localeCompare(String(b.time)));
  return {
    points,
    sampleCount: points.length,
    dayCount: new Set(points.map((p) => p.date)).size,
    maxKw: points[0]?.kw ?? null,
    maxExcessKw: points[0]?.excess_kw ?? null,
    excessKwh: points.reduce((sum, p) => sum + p.excess_kw * 0.25, 0),
    top: points.slice(0, 20),
  };
}

function exceedanceSummarySection(exceedance, contractKw) {
  if (!contractKw) return '<section><h2>Contract Capacity Exceedance</h2><p class="muted">No contract capacity was found in the source artifact.</p></section>';
  const rows = (exceedance.top || []).map((p) => '<tr><td>' + esc(p.date) + '</td><td>' + esc(p.time) + '</td><td>' + fmt(p.kw, 1) + '</td><td>' + fmt(contractKw, 0) + '</td><td>' + fmt(p.excess_kw, 1) + '</td><td>' + esc(p.tou || '-') + '</td></tr>').join('');
  const body = rows || '<tr><td colspan="6">No authenticated 15-minute load point exceeded contract capacity.</td></tr>';
  return '<section><h2>Contract Capacity Exceedance</h2><div class="cards"><div class="card"><div class="label">Exceedance Samples</div><div class="value">' + fmt(exceedance.sampleCount, 0) + '</div></div><div class="card"><div class="label">Affected Days</div><div class="value">' + fmt(exceedance.dayCount, 0) + '</div></div><div class="card"><div class="label">Max Excess</div><div class="value">' + fmt(exceedance.maxExcessKw, 1) + ' kW</div></div><div class="card"><div class="label">Excess Energy Area</div><div class="value">' + fmt(exceedance.excessKwh, 1) + ' kWh</div></div></div><p class="muted">A point is marked when authenticated selected load is greater than contract capacity (' + fmt(contractKw, 0) + ' kW). Excess energy area is sum((kW - contract) * 0.25h), for screening only.</p><table><thead><tr><th>Date</th><th>Time</th><th>Load kW</th><th>Contract kW</th><th>Excess kW</th><th>TOU</th></tr></thead><tbody>' + body + '</tbody></table></section>';
}

function maxFor(seriesList, contractKw) {
  const values = [];
  for (const series of seriesList) values.push(...series.points.map((p) => num(p.y) || 0));
  if (contractKw) values.push(contractKw);
  return Math.max(1, ...values);
}

function lineChart(seriesList, title, unit, options = {}) {
  const width = 980, height = 302, left = 58, right = 18, top = 24, bottom = 44;
  const points = seriesList[0]?.points || [];
  const max = maxFor(seriesList, options.contractKw);
  const tickIndexes = timeTickIndices(points, 4);
  const ticks = tickIndexes.map((index) => ({ index, label: points[index]?.x || "" }));
  const x = (i) => left + (i * (width - left - right)) / Math.max(1, points.length - 1);
  const y = (v) => height - bottom - ((num(v) || 0) / max) * (height - top - bottom);
  const bandW = (width - left - right) / Math.max(1, (options.touBands || []).length - 1);
  const bands = (options.touBands || []).map((band, i) => `<rect x="${x(i).toFixed(1)}" y="${top}" width="${Math.max(1, bandW).toFixed(1)}" height="${height-top-bottom}" fill="${colorForCategory(band.category)}" opacity="0.45"><title>${esc(band.time)} ${esc(band.category)}</title></rect>`).join("");
  const paths = seriesList.map((series, idx) => {
    const d = series.points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.y).toFixed(1)}`).join(" ");
    const color = series.color || `hsl(${(idx * 41) % 360} 52% 40%)`;
    const opacity = series.opacity ?? 0.25;
    return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${series.width || 1.15}" opacity="${opacity}"><title>${esc(series.name)}</title></path>`;
  }).join("");
  const exceedanceMarkers = options.contractKw ? seriesList.map((series) => series.points.map((p, i) => {
    const value = num(p.y) || 0;
    if (value <= options.contractKw) return "";
    return '<circle class="exceedance-point" cx="' + x(i).toFixed(1) + '" cy="' + y(value).toFixed(1) + '" r="3.1"><title>' + esc(series.name) + ' '+ esc(p.x) + ' '+ fmt(value, 1) + ' kW; excess '+ fmt(value - options.contractKw, 1) + ' kW</title></circle>';
  }).join("")).join("") : "";
  const contract = options.contractKw ? `<line class="contract" x1="${left}" y1="${y(options.contractKw).toFixed(1)}" x2="${width-right}" y2="${y(options.contractKw).toFixed(1)}"/><text x="${width-right-104}" y="${(y(options.contractKw)-5).toFixed(1)}" class="contract-label">Contract ${fmt(options.contractKw,0)} kW</text>` : "";
  const labels = xTickLabels(width, height, left, right, points.length, ticks, height - 12);
  const legend = Array.from(new Set((options.touBands || []).map((b) => b.category).filter(Boolean))).map((cat) => `<span><i style="background:${colorForCategory(cat)}"></i>${esc(cat)}</span>`).join("");
  const exceedanceLegend = options.contractKw ? '<span><i class="exceedance-swatch"></i>Above contract</span>' : "";
  return '<figure><figcaption>' + esc(title) + '</figcaption><div class="legend">' + legend + exceedanceLegend + '</div><svg viewBox="0 0 ' + width + ' ' + height + '">' + bands + axes(width,height,left,right,top,bottom,max,points.length,ticks) + contract + paths + exceedanceMarkers + labels + '<text x="8" y="16">' + esc(unit) + '</text></svg></figure>';
}

function barChart(points, title, unit, contractKw = null) {
  const width = 980, height = 300, left = 58, right = 18, top = 24, bottom = 62;
  const max = Math.max(1, ...points.map((p) => num(p.y) || 0), contractKw || 0);
  const inner = width - left - right;
  const step = inner / Math.max(1, points.length);
  const ticks = xTickObjects(points, 12);
  const y = (v) => height - bottom - ((num(v) || 0) / max) * (height - top - bottom);
  const xCenter = (i) => left + i * step + step / 2;
  const bars = points.map((p, i) => {
    const v = num(p.y) || 0;
    const h = (v / max) * (height - top - bottom);
    const cls = contractKw && v > contractKw ? ' class="exceedance-bar"' : "";
    const excess = contractKw && v > contractKw ? '; excess ' + fmt(v - contractKw, 1) + ' kW' : "";
    const time = p.time ? '; peak time ' + p.time : "";
    return '<rect' + cls + ' x="' + (left + i*step).toFixed(1) + '" y="' + (height-bottom-h).toFixed(1) + '" width="' + Math.max(2, step-2).toFixed(1) + '" height="' + h.toFixed(1) + '"><title>' + esc(p.date || p.x) + ' '+ fmt(v,1) + ' '+ esc(unit) + time + excess + '</title></rect>';
  }).join("");
  const contract = contractKw ? `<line class="contract" x1="${left}" y1="${y(contractKw).toFixed(1)}" x2="${width-right}" y2="${y(contractKw).toFixed(1)}"/>` : "";
  let annotations = "";
  if (points.length && points.some((p) => p.time)) {
    const maxPoint = points.reduce((best, p, index) => (num(p.y) || 0) > (num(best.point?.y) || 0) ? { point: p, index } : best, { point: points[0], index: 0 });
    const value = num(maxPoint.point.y) || 0;
    annotations = '<line class="annotation-line" x1="' + xCenter(maxPoint.index).toFixed(1) + '" y1="' + top + '" x2="' + xCenter(maxPoint.index).toFixed(1) + '" y2="' + (height-bottom) + '"/><text class="annotation-label" x="' + xCenter(maxPoint.index).toFixed(1) + '" y="' + Math.max(14, y(value) - 8).toFixed(1) + '" text-anchor="middle">' + esc((maxPoint.point.date || maxPoint.point.x) + (maxPoint.point.time ? ' ' + maxPoint.point.time : '')) + '</text>';
  }
  const legend = contractKw ? '<div class="legend"><span><i class="exceedance-swatch"></i>Above contract</span></div>' : "";
  return '<figure><figcaption>' + esc(title) + '</figcaption>' + legend + '<svg viewBox="0 0 ' + width + ' ' + height + '">' + axes(width,height,left,right,top,bottom,max,points.length,ticks) + contract + '<g class="bars">' + bars + '</g>' + annotations + xTickLabels(width,height,left,right,points.length,ticks,height - 16,true) + '<text x="8" y="16">' + esc(unit) + '</text></svg></figure>';
}

function heatmapSvg(rows, contractKw = null) {
  const times = rows[0]?.points.map((p) => p.time) || [];
  const cw = 8, ch = 12, left = 88, top = 34;
  const legendW = 220;
  const width = left + times.length * cw + legendW;
  const height = top + rows.length * ch + 28;
  const max = Math.max(1, ...rows.flatMap((row) => row.points.map((p) => p.value)));
  const color = (value) => {
    const t = Math.max(0, Math.min(1, value / max));
    return `rgb(${Math.round(238 - t * 185)},${Math.round(243 - t * 84)},${Math.round(247 - t * 50)})`;
  };
  const rects = rows.map((row, r) => row.points.map((p, c) => {
    const isExceed = contractKw && p.value > contractKw;
    const cls = isExceed ? ' class="exceedance-cell"' : "";
    const excess = isExceed ? '; excess ' + fmt(p.value - contractKw, 1) + ' kW' : "";
    return '<rect' + cls + ' x="' + (left + c*cw) + '" y="' + (top + r*ch) + '" width="' + cw + '" height="' + ch + '" fill="' + color(p.value) + '"><title>' + esc(row.date) + ' '+ esc(p.time) + ' '+ fmt(p.value, 1) + ' kW' + excess + '</title></rect>';
  }).join("")).join("");
  const yTickStep = Math.max(1, Math.ceil(rows.length / 24));
  const yLabels = rows.filter((_, i) => i % yTickStep === 0 || i === rows.length - 1).map((row) => `<text x="${left - 8}" y="${top + rows.indexOf(row)*ch + 9}" text-anchor="end">${esc(row.date.slice(5))}</text>`).join("");
  const timeTicks = timeTickIndices(times.map((time) => ({ x: time })), 4).map((index) => ({ index, label: times[index] }));
  const xLabels = timeTicks.map((tick) => `<text x="${left + tick.index*cw}" y="22" text-anchor="middle">${esc(tick.label)}</text><line class="grid" x1="${left + tick.index*cw}" y1="${top}" x2="${left + tick.index*cw}" y2="${top + rows.length*ch}"/>`).join("");
  const scaleX = left + times.length * cw + 28;
  const swatches = Array.from({ length: 8 }, (_, i) => {
    const x = scaleX + i * 18;
    const value = max * i / 7;
    return `<rect x="${x}" y="${top}" width="18" height="12" fill="${color(value)}"/>`;
  }).join("");
  const magnitudeLegend = `<text x="${scaleX}" y="${top - 8}">Load magnitude (kW)</text>${swatches}<text x="${scaleX}" y="${top + 30}">0</text><text x="${scaleX + 144}" y="${top + 30}" text-anchor="end">${fmt(max,0)}</text>`;
  const legend = contractKw ? '<div class="legend"><span><i class="exceedance-swatch"></i>Above contract</span></div>' : "";
  return '<figure><figcaption>15-minute Load Heatmap</figcaption>' + legend + '<svg class="heatmap" viewBox="0 0 ' + width + ' ' + height + '">' + xLabels + yLabels + rects + magnitudeLegend + '</svg></figure>';
}

function profileSeriesForRows(rows, average = false) {
  if (average) return [{ name: "Average", width: 2.4, opacity: 1, color: "#176fb8", points: averageProfile(rows) }];
  return rows.map((row) => ({ name: row.date, points: row.points.map((p) => ({ x: p.time, y: p.value })) }));
}

function bucketSection(rows, key, title, contractKw) {
  const matched = rows.filter((row) => dayBucket(row) === key);
  if (!matched.length) return `<section><h2>${esc(title)}</h2><p class="muted">No matched days in this artifact.</p></section>`;
  return `<section>${lineChart(profileSeriesForRows(matched), `${title} - all matched days (${matched.length})`, "kW", { contractKw, touBands: profileTouBands(matched) })}</section>`;
}

function main() {
  const basicPath = path.resolve(opt("--basic"));
  const rangePath = path.resolve(opt("--range"));
  const basic = readJson(basicPath, "basic artifact");
  const range = readJson(rangePath, "range artifact");
  const rows = dailyRows(range);
  if (!rows.length) throw new Error("Range artifact contains no daily rows.");

  const electric = findValueByKeyPattern(basic, [/電號/]) || path.basename(path.dirname(rangePath));
  const customer = findValueByKeyPattern(basic, [/戶名/]);
  const address = findValueByKeyPattern(basic, [/地址/]);
  const tariff = findValueByKeyPattern(basic, [/計費類別/]);
  const contractKw = findContractKw(basic);
  const bills = billRows(basic);
  const peak = rows.reduce((best, row) => row.peakKw > best.peakKw ? row : best, rows[0]);
  const totalKwh = rows.reduce((sum, row) => sum + row.totalKwh, 0);
  const plottedCategories = Array.from(new Set(rows.flatMap((row) => Array.from(row.actualCategories || [])))).sort();
  const rejectedCategories = Array.from(new Set(rows.flatMap((row) => Array.from(row.rejectedCategories || [])))).sort();
  const contractSampleCount = rows.reduce((sum, row) => sum + (row.contractSampleCount || 0), 0);
  const contractMaxKwFromRange = Math.max(0, ...rows.map((row) => row.contractMaxKw || 0));
  const overlappingTouSlotCount = rows.reduce((sum, row) => sum + (row.overlappingTouSlotCount || 0), 0);
  const expectedSamples = rows.length * 96;
  const actualSamples = rows.reduce((sum, row) => sum + row.points.length, 0);
  const emptyDays = rows.filter((row) => row.points.length === 0 || row.points.every((p) => p.value === 0)).length;
  const start = (range.target_range?.start_date?.gregorian || rows[0].date).replaceAll("/", "-");
  const end = (range.target_range?.end_date?.gregorian || rows.at(-1).date).replaceAll("/", "-");
  const outDir = path.resolve(opt("--out") || path.join(REPORTS_DIR, `hvcs-report-${electric}-${start}_to_${end}`));
  fs.mkdirSync(outDir, { recursive: true });

  const dailyPeak = rows.map((row) => ({ x: row.date.slice(5), date: row.date, y: row.peakKw, time: row.peakTime }));
  const dailyEnergy = rows.map((row) => ({ x: row.date.slice(5), y: row.totalKwh }));
  const exceedance = contractExceedances(rows, contractKw);
  const billTable = bills.map((bill) => `<tr><td>${esc(bill.month)}</td><td>${esc(bill.period || "-")}</td><td>${fmt(bill.basicFee, 1)}</td><td>${fmt(bill.energyFee, 1)}</td><td>${fmt(bill.basicFee2, 1)}</td><td>${fmt(bill.powerFactor, 0)}</td><td>${fmt(bill.powerFactorAdjustment, 1)}</td><td>${fmt(bill.otherAdjustment, 1)}</td><td>${fmt(bill.total, 0)}</td></tr>`).join("");
  const bucketCounts = rows.reduce((acc, row) => { acc[dayBucket(row)] = (acc[dayBucket(row)] || 0) + 1; return acc; }, {});

  const html = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>HVCS Source Report ${esc(start)} - ${esc(end)}</title><style>
  :root{--ink:#172033;--muted:#657181;--line:#d8e0e8;--bg:#f5f7fa;--panel:#fff;--accent:#176fb8}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:"Segoe UI","Microsoft JhengHei",Arial,sans-serif}header{background:#fff;border-bottom:1px solid var(--line);padding:28px 34px 18px}h1{margin:0 0 8px;font-size:26px}main{display:grid;gap:18px;padding:22px 34px 38px}section{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:18px;overflow:auto}h2{margin:0 0 14px;font-size:18px}.muted{color:var(--muted)}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}.card{border:1px solid var(--line);border-radius:8px;background:#fbfcfe;padding:12px}.label{font-size:12px;color:var(--muted)}.value{font-size:22px;font-weight:650;margin-top:4px}table{border-collapse:collapse;width:100%;font-size:13px}th,td{border-bottom:1px solid var(--line);padding:8px 9px;text-align:left;white-space:nowrap}th{color:var(--muted);font-weight:600}figure{margin:0}figcaption{font-weight:650;margin-bottom:10px}svg{display:block;width:100%;height:auto}.axis{stroke:#8794a3;stroke-width:1}.grid{stroke:#d8e0e8;stroke-width:1}.line{fill:none;stroke:var(--accent);stroke-width:2.1}.bars rect{fill:#3a88c9}.bars rect.exceedance-bar{fill:#d94841}.exceedance-point{fill:#d94841;stroke:#fff;stroke-width:1.2}.exceedance-cell{stroke:#d94841;stroke-width:1.4}.exceedance-swatch{background:#d94841!important}.annotation-line{stroke:#d94841;stroke-width:1;stroke-dasharray:3 3}.annotation-label{fill:#9f2722;font-size:11px;font-weight:600}.contract{stroke:#111827;stroke-width:1.5;stroke-dasharray:6 4}.contract-label{fill:#111827;font-size:12px}.legend{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:6px;color:var(--muted);font-size:12px}.legend i{display:inline-block;width:16px;height:10px;border:1px solid var(--line);margin-right:4px;vertical-align:-1px}svg text{fill:#657181;font-size:11px}</style></head><body>
<header><h1>HVCS Source Report</h1><div class="muted">${esc(start)} - ${esc(end)} · Electric number ${esc(electric)}</div></header><main>
<section><h2>Source Summary</h2><div class="cards"><div class="card"><div class="label">Total Energy</div><div class="value">${fmt(totalKwh,0)} kWh</div></div><div class="card"><div class="label">Peak Demand</div><div class="value">${fmt(peak.peakKw,1)} kW</div><div class="muted">${esc(peak.date)} ${esc(peak.peakTime)}</div></div><div class="card"><div class="label">Data Completeness</div><div class="value">${actualSamples}/${expectedSamples}</div><div class="muted">empty days: ${emptyDays}</div></div></div><p class="muted">Plotted load uses only authenticated HVCS TOU demand series: ${esc(plottedCategories.join(", ") || "-")}. If HVCS exposes overlapping TOU series at the same timestamp, the report selects one active value instead of summing duplicates. Contract/reference samples are excluded from load charts and used only as reference lines.</p></section>
<section><h2>Site</h2><table><tbody><tr><th>Customer</th><td>${esc(customer || "-")}</td></tr><tr><th>Address</th><td>${esc(address || "-")}</td></tr><tr><th>Tariff</th><td>${esc(tariff || "-")}</td></tr><tr><th>Contract Capacity</th><td>${contractKw ? `${fmt(contractKw,0)} kW` : "-"}</td></tr></tbody></table></section>
<section>${barChart(dailyPeak, "Daily Peak Demand", "kW", contractKw)}</section>
${exceedanceSummarySection(exceedance, contractKw)}
<section>${barChart(dailyEnergy, "Daily Energy", "kWh")}</section>
${bucketSection(rows, "summer_working", "Summer working day (平日)", contractKw)}
${bucketSection(rows, "summer_offpeak", "Summer off-peak day (離峰日)", contractKw)}
${bucketSection(rows, "non_summer_working", "Non-summer working day (平日)", contractKw)}
${bucketSection(rows, "non_summer_offpeak", "Non-summer off-peak day (離峰日)", contractKw)}
<section>${heatmapSvg(rows, contractKw)}</section>
<section><h2>Bill Table</h2><p class="muted">Money columns are in NTD. Power factor is percent.</p><table><thead><tr><th>Bill Month</th><th>Billing Period</th><th>Basic Fee (NTD)</th><th>Energy Fee (NTD)</th><th>Extra Basic Fee (NTD)</th><th>Power Factor (%)</th><th>PF Adjustment (NTD)</th><th>Other Adjustment (NTD)</th><th>Total (NTD)</th></tr></thead><tbody>${billTable}</tbody></table></section>
<section><h2>Source Artifacts</h2><table><tbody><tr><th>Basic</th><td>${esc(path.relative(ROOT, path.resolve(basicPath)))}</td></tr><tr><th>Range</th><td>${esc(path.relative(ROOT, path.resolve(rangePath)))}</td></tr><tr><th>Generated</th><td>${esc(new Date().toISOString())}</td></tr></tbody></table></section>
</main></body></html>`;

  fs.writeFileSync(path.join(outDir, "index.html"), html, "utf8");
  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify({
    electric_number: electric, start, end, days: rows.length, total_kwh: totalKwh,
    peak_kw: peak.peakKw, peak_date: peak.date, peak_time: peak.peakTime,
    contract_kw: contractKw, expected_samples: expectedSamples, actual_samples: actualSamples,
    empty_days: emptyDays, bucket_counts: bucketCounts,
    load_data_integrity: "Only authenticated TOU load categories are plotted; one active TOU value is selected per timestamp; contract capacity/reference series are excluded from load samples.",
    plotted_load_categories: plottedCategories,
    rejected_non_load_categories: rejectedCategories,
    contract_reference_sample_count: contractSampleCount,
    contract_reference_max_kw: contractMaxKwFromRange || null,
    overlapping_tou_slot_count: overlappingTouSlotCount,
    contract_exceedance_sample_count: exceedance.sampleCount,
    contract_exceedance_day_count: exceedance.dayCount,
    contract_exceedance_max_kw: exceedance.maxKw,
    contract_exceedance_max_excess_kw: exceedance.maxExcessKw,
    contract_exceedance_excess_kwh: exceedance.excessKwh,
    contract_exceedance_top: exceedance.top,
    day_classification: "TOU categories from extracted HVCS series; summer rule May 16-Oct 15 from Taipower season calendar.",
    basic_artifact: path.relative(ROOT, path.resolve(basicPath)),
    range_artifact: path.relative(ROOT, path.resolve(rangePath))
  }, null, 2), "utf8");
  console.log(outDir);
}

main();
