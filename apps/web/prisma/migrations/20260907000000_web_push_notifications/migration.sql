ALTER TABLE "users"
ADD COLUMN "browserNotificationsEnabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "web_push_subscriptions" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "expirationTime" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "web_push_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "web_push_subscriptions_endpoint_key"
ON "web_push_subscriptions"("endpoint");

CREATE INDEX "web_push_subscriptions_userId_idx"
ON "web_push_subscriptions"("userId");

ALTER TABLE "web_push_subscriptions"
ADD CONSTRAINT "web_push_subscriptions_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "users"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
