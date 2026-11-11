// Enhanced JavaScript implementation of the Python time server
// Uses native JavaScript Date API with proper timezone handling.
//
// All conversions work from absolute instants: a wall-clock time is resolved to
// a UTC instant using the target zone's offset at that instant (iterated twice so
// DST transitions settle), then re-rendered in whichever zone is requested.
// This keeps results independent of the machine's own TZ setting.

export interface TimeResult {
  timezone: string;
  datetime: string;
  day_of_week: string;
  is_dst: boolean;
}

export interface TimeConversionResult {
  source: TimeResult;
  target: TimeResult;
  time_difference: string;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const MINUTE_MS = 60_000;

export class TimeManager {
  private getLocalTimezone(): string {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return 'UTC';
    }
  }

  private isValidTimezone(timezone: string): boolean {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: timezone });
      return true;
    } catch {
      return false;
    }
  }

  /** Wall-clock parts of an absolute instant, as seen in `timezone`. */
  private zonedParts(date: Date, timezone: string): ZonedParts {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).formatToParts(date);

    const get = (type: string): number => {
      const value = parts.find((p) => p.type === type)?.value;
      return value === undefined ? 0 : Number(value);
    };

    return {
      year: get('year'),
      month: get('month'),
      day: get('day'),
      // Some engines render midnight as "24" even with hour12: false.
      hour: get('hour') % 24,
      minute: get('minute'),
      second: get('second')
    };
  }

  /** UTC offset of `timezone` at a specific instant, in minutes (east positive). */
  private offsetMinutesAt(date: Date, timezone: string): number {
    const p = this.zonedParts(date, timezone);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const instant = Math.floor(date.getTime() / 1000) * 1000;
    return Math.round((asUtc - instant) / MINUTE_MS);
  }

  /** Resolve a wall-clock time in `timezone` to the matching absolute instant. */
  private wallTimeToInstant(
    timezone: string,
    year: number,
    month: number,
    day: number,
    hour: number,
    minute: number
  ): Date {
    const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
    let guess = wallAsUtc;

    // Two passes are enough to settle even across a DST boundary.
    for (let i = 0; i < 3; i += 1) {
      const offset = this.offsetMinutesAt(new Date(guess), timezone);
      const next = wallAsUtc - offset * MINUTE_MS;
      if (next === guess) break;
      guess = next;
    }

    return new Date(guess);
  }

  private dayOfWeek(date: Date, timezone: string): string {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'long'
    }).format(date);
  }

  /** Render an instant as ISO-8601 with the zone's real offset. */
  private formatIso(date: Date, timezone: string): string {
    const p = this.zonedParts(date, timezone);
    const offset = this.offsetMinutesAt(date, timezone);
    const ms = String(date.getUTCMilliseconds()).padStart(3, '0');
    return (
      `${String(p.year).padStart(4, '0')}-${this.pad(p.month)}-${this.pad(p.day)}` +
      `T${this.pad(p.hour)}:${this.pad(p.minute)}:${this.pad(p.second)}.${ms}` +
      this.formatOffset(offset)
    );
  }

  private pad(value: number): string {
    return String(value).padStart(2, '0');
  }

  private formatOffset(minutes: number): string {
    const sign = minutes >= 0 ? '+' : '-';
    const abs = Math.abs(minutes);
    return `${sign}${this.pad(Math.floor(abs / 60))}:${this.pad(abs % 60)}`;
  }

  private formatTimeDifference(minutes: number): string {
    const sign = minutes >= 0 ? '+' : '-';
    const abs = Math.abs(minutes);
    const hours = Math.floor(abs / 60);
    const remainder = abs % 60;
    return remainder === 0 ? `${sign}${hours}h` : `${sign}${hours}h${this.pad(remainder)}m`;
  }

  getCurrentTime(timezone: string): TimeResult {
    if (!this.isValidTimezone(timezone)) {
      throw new Error(`Invalid timezone: ${timezone}`);
    }

    const now = new Date();

    return {
      timezone,
      datetime: this.formatIso(now, timezone),
      day_of_week: this.dayOfWeek(now, timezone),
      is_dst: this.isDST(now, timezone)
    };
  }

  convertTime(sourceTimezone: string, timeStr: string, targetTimezone: string): TimeConversionResult {
    if (!this.isValidTimezone(sourceTimezone)) {
      throw new Error(`Invalid source timezone: ${sourceTimezone}`);
    }
    if (!this.isValidTimezone(targetTimezone)) {
      throw new Error(`Invalid target timezone: ${targetTimezone}`);
    }

    // Parse time string (HH:MM format)
    const timeMatch = timeStr.match(/^(\d{1,2}):(\d{2})$/);
    if (!timeMatch) {
      throw new Error('Invalid time format. Expected HH:MM [24-hour format]');
    }

    const hour = parseInt(timeMatch[1], 10);
    const minute = parseInt(timeMatch[2], 10);

    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      throw new Error('Invalid time values');
    }

    // "Today" means today in the source timezone, not the host machine's zone.
    const today = this.zonedParts(new Date(), sourceTimezone);
    const instant = this.wallTimeToInstant(
      sourceTimezone,
      today.year,
      today.month,
      today.day,
      hour,
      minute
    );

    const sourceOffset = this.offsetMinutesAt(instant, sourceTimezone);
    const targetOffset = this.offsetMinutesAt(instant, targetTimezone);

    return {
      source: {
        timezone: sourceTimezone,
        datetime: this.formatIso(instant, sourceTimezone),
        day_of_week: this.dayOfWeek(instant, sourceTimezone),
        is_dst: this.isDST(instant, sourceTimezone)
      },
      target: {
        timezone: targetTimezone,
        datetime: this.formatIso(instant, targetTimezone),
        day_of_week: this.dayOfWeek(instant, targetTimezone),
        is_dst: this.isDST(instant, targetTimezone)
      },
      time_difference: this.formatTimeDifference(targetOffset - sourceOffset)
    };
  }

  /**
   * A zone observes DST when its January and July offsets differ and the
   * instant's own offset is the larger (DST) one. Southern-hemisphere zones
   * therefore report correctly too.
   */
  private isDST(date: Date, timezone: string): boolean {
    try {
      const { year } = this.zonedParts(date, timezone);
      const january = this.offsetMinutesAt(new Date(Date.UTC(year, 0, 1, 12)), timezone);
      const july = this.offsetMinutesAt(new Date(Date.UTC(year, 6, 1, 12)), timezone);

      if (january === july) return false;

      return this.offsetMinutesAt(date, timezone) > Math.min(january, july);
    } catch {
      return false;
    }
  }

  /**
   * Get a list of common timezones
   */
  public getCommonTimezones(): string[] {
    return [
      'UTC',
      'America/New_York',
      'America/Chicago',
      'America/Denver',
      'America/Los_Angeles',
      'Europe/London',
      'Europe/Paris',
      'Europe/Berlin',
      'Asia/Tokyo',
      'Asia/Shanghai',
      'Asia/Kolkata',
      'Australia/Sydney',
      'Pacific/Auckland'
    ];
  }

  /**
   * Get the local timezone
   */
  public getLocalTimezonePublic(): string {
    return this.getLocalTimezone();
  }
}
