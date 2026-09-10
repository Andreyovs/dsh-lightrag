// Формат даты в локальном времени: "09.09 17:55".
export function fmtTime(value) {
  if (value === null || value === undefined || value === "") return "—";
  const d = new Date(typeof value === "number" ? value : value);
  if (Number.isNaN(d.getTime())) return "—";
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
