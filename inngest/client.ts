import { Inngest, EventSchemas } from "inngest";
import type { LedgerEvents } from "@/lib/runtime/events";

export const inngest = new Inngest({
  id: "work-ledger",
  schemas: new EventSchemas().fromRecord<LedgerEvents>(),
  eventKey: process.env.INNGEST_EVENT_KEY,
});
