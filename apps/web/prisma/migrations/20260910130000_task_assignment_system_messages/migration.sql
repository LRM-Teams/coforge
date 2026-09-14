-- NULL sender represents server-authored Messages, never an anonymous member send.
ALTER TABLE "messages" ALTER COLUMN "senderMemberId" DROP NOT NULL;
