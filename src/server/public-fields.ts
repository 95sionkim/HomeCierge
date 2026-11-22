// 공고일과 관측 시각을 실제 달력으로 검사한다.
export function isDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

const timestampPattern = /^[0-9]{4}-[0-9]{2}-[0-9]{2}[Tt](?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]{1,9})?(?:[Zz]|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])$/;

export function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && timestampPattern.test(value)
    && isDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value));
}

export const koreaDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
});

const nonPublicLabelPattern = /\p{Cc}|\p{Cs}|:\/\/|\/\/[a-z0-9]|www\.|https?:|ftp:|file:|javascript:|data:|blob:|mailto:|tel:|analysis-uploads|upload[:/]|@/iu;

export function isPublicLabel(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
    && value === value.trim() && !nonPublicLabelPattern.test(value);
}
