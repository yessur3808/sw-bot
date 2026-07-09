CREATE TABLE IF NOT EXISTS public_holidays (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    region TEXT NOT NULL,
    holiday_date TEXT NOT NULL,
    holiday_name TEXT NOT NULL,
    source_name TEXT,
    source_url TEXT,
    source_meta TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(region, holiday_date)
);

CREATE INDEX IF NOT EXISTS idx_public_holidays_region_date ON public_holidays(region, holiday_date);
CREATE INDEX IF NOT EXISTS idx_public_holidays_date ON public_holidays(holiday_date);