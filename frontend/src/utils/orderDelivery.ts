import brickwithTransitDays from '../data/brickwithTransitDays.json';

type TransitMethods = { standard?: number[]; fast?: number[] };
const transitByCountry: Readonly<Record<string, TransitMethods | undefined>> = brickwithTransitDays;
const fulfillmentBusinessDays = 12;
const warehouseDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' });
const shortDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

// Supplier extensions apply to orders placed during the published windows.
const busyPeriods = [
  { start: '2026-11-27', end: '2026-12-09', delay: [7, 10] },
  { start: '2026-12-25', end: '2027-01-06', delay: [7, 10] },
  { start: '2027-01-27', end: '2027-02-27', delay: [10, 20] },
];

// China public holidays. Brickwith's business-day policy also excludes weekends.
const publicHolidays = [
  ['2027-01-01', '2027-01-03'], ['2027-02-05', '2027-02-13'],
  ['2027-04-03', '2027-04-05'], ['2027-05-01', '2027-05-05'],
  ['2027-06-09', '2027-06-09'], ['2027-09-15', '2027-09-15'],
  ['2027-10-01', '2027-10-07'],
];

function toWarehouseDay(orderTime: Date) {
  const parts = warehouseDate.formatToParts(orderTime);
  const year = Number(parts.find(part => part.type === 'year')?.value);
  const month = Number(parts.find(part => part.type === 'month')?.value);
  const day = Number(parts.find(part => part.type === 'day')?.value);
  return new Date(Date.UTC(year, month - 1, day));
}

function addDays(date: Date, days: number) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function addBusinessDays(date: Date, days: number) {
  let result = date;
  while (days > 0) {
    result = addDays(result, 1);
    const dayOfWeek = result.getUTCDay();
    const day = result.toISOString().slice(0, 10);
    if (dayOfWeek !== 0 && dayOfWeek !== 6 && !publicHolidays.some(([start, end]) => start <= day && day <= end)) {
      days -= 1;
    }
  }
  return result;
}

export function getEstimatedArrival(country: string, orderTime = new Date()) {
  if (!Object.hasOwn(transitByCountry, country)) return null;
  const methods = transitByCountry[country];
  const transit = methods?.standard ?? methods?.fast;
  if (!transit) return null;

  const orderDay = toWarehouseDay(orderTime);
  const day = orderDay.toISOString().slice(0, 10);
  const [minDelay, maxDelay] = busyPeriods.find(({ start, end }) => start <= day && day <= end)?.delay ?? [0, 0];
  const earliest = addDays(addBusinessDays(orderDay, fulfillmentBusinessDays + minDelay), transit[0]);
  const latest = addDays(addBusinessDays(orderDay, fulfillmentBusinessDays + maxDelay), transit[1]);
  return shortDate.formatRange(earliest, latest);
}
