// util/date.js
function startOfDay(date = new Date()) {
  const d = new Date(date);
  d.setHours(0,0,0,0);
  return d;
}
function isToday(d) {
  const a = startOfDay(d);
  const b = startOfDay(new Date());
  return a.getTime() === b.getTime();
}
function addSeconds(date, seconds) {
  return new Date(date.getTime() + (seconds * 1000));
}
module.exports = { startOfDay, isToday, addSeconds };
