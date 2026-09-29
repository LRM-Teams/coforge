# Atomic write paths

## Send a canonical message

1. Check or reserve the authorized sender's stable `request_id` in the bounded,
   expiring Redis idempotency state; return its stored result on a retry.
2. Verify that the sender is a member of the direct conversation.
3. Start a transaction, lock the conversation row, read the current maximum
   `Message.sequence`, and allocate the next value.
4. Insert `Message`; there is no
   database request-id uniqueness check.
5. Commit and record the result for `request_id` in Redis, then, in a User↔Agent
   conversation, publish a volatile attention to the targeted online Agent. A
   conversation between people delivers to no Agent.
   Missed attention is recovered from canonical Message/read state, not a
   delivery-ledger row.

The current sequence allocator serializes writers by locking the conversation
row before reading `MAX(Message.sequence) + 1`. `Conversation` has no stored
next-sequence counter; `(conversationId, sequence)` is the database uniqueness
constraint.

## Create or find a direct conversation

Insert `Conversation(workspaceId, directKey)` and one `ConversationMember` row
per distinct participant (its User and Agent, or its people). On a unique-key
conflict, select the existing canonical conversation by
`(workspaceId, directKey)`. There is no conversation kind column: the key's
`agent:`/`user:` parts say which kind of direct conversation it is.
