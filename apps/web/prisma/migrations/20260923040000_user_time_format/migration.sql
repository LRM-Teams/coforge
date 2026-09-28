-- Language & region: the viewer's 12- or 24-hour clock. NULL follows the display language.
ALTER TABLE "user_preferences" ADD COLUMN "timeFormat" TEXT,
ADD CONSTRAINT "user_preferences_timeFormat_check" CHECK ("timeFormat" IN ('12h', '24h'));
