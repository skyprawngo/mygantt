/* Instants use the selected zone. YYYY-MM-DD schedule dates stay date-only. */
const MyGanttTime = (() => {
  function valid(zone) {
    if (!zone || typeof zone !== 'string') return false;
    try { new Intl.DateTimeFormat('en', {timeZone:zone}); return true; } catch { return false; }
  }
  function parts(now, override, server = {}) {
    const zone = valid(override) ? override : valid(server.time_zone) ? server.time_zone : 'UTC';
    const fallback = !valid(override) && !valid(server.time_zone);
    const instant = fallback ? new Date(now.getTime() + (Number(server.offset_minutes) || 0)*60000) : now;
    const result = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(instant).map(p=>[p.type,p.value]));
    return {...result, date:`${result.year}-${result.month}-${result.day}`};
  }
  function zones(extra = []) {
    const available = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : ['Asia/Seoul','Asia/Tokyo','Asia/Shanghai','Asia/Kolkata','Asia/Dubai','Europe/London','Europe/Paris','America/New_York','America/Chicago','America/Denver','America/Los_Angeles','Australia/Sydney','Pacific/Auckland'];
    return [...new Set(['UTC',...available,...extra])].filter(valid).sort();
  }
  return {parts,valid,zones};
})();
if (typeof module !== 'undefined') module.exports = MyGanttTime;
