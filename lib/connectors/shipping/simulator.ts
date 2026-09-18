import { createHash } from "node:crypto";
import { fixture } from "@/lib/fixtures";
import { defineConnector, result, type Connector } from "../kit";

type ShippingFixture = {
  carrier: string;
  service_levels: string[];
  serviceable_postcodes: string[];
  transit_days: Record<string, number>;
};

type Shipment = {
  tracking_number: string;
  to: Record<string, unknown>;
  service_level: string;
  booked_at: string;
  expected_at: string;
  status: string;
  cancelled?: boolean;
};

/**
 * The carrier. A booking produces a tracking number that only resolves in
 * track(), so tracking_valid is a real lookup rather than a claim in an output.
 */
export function createShippingSimulator(fixturePath = "day_one/shipping.json"): Connector {
  const data = fixture<ShippingFixture>(fixturePath);
  const shipments = new Map<string, Shipment>();

  return defineConnector({
    id: "shipping",
    kind: "shipping",
    impl: "simulator",
    capabilities: { read: true, write: true, asOf: false, webhook: true },
    dataPolicy: "allowed",
    ops: {
      book: {
        name: "book",
        description:
          "Books a delivery to the address given and returns a tracking number. The address must be the one that is correct today, not one copied from a document.",
        write: true,
        evidenceKind: "shipping_booking",
        input: {
          type: "object",
          properties: {
            to: { type: "object", description: "the delivery address: line1, line2, city, state, postcode, country" },
            service_level: { type: "string", description: "ground, two_day or overnight" },
            reference: { type: "string", description: "the asset tag or order reference" },
          },
          required: ["to"],
        },
        run(args, ctx) {
          const to = (args.to ?? {}) as Record<string, unknown>;
          const postcode = String(to.postcode ?? "");
          if (!data.serviceable_postcodes.includes(postcode)) {
            throw new Error(`the carrier does not serve ${postcode || "an address with no postcode"}`);
          }
          const serviceLevel = String(args.service_level ?? "two_day");
          if (!data.service_levels.includes(serviceLevel)) {
            throw new Error(`no service level ${serviceLevel}`);
          }
          const digest = createHash("sha256")
            .update(`${JSON.stringify(to)}|${serviceLevel}|${shipments.size}`)
            .digest("hex")
            .slice(0, 10)
            .toUpperCase();
          const trackingNumber = `${data.carrier.toUpperCase().slice(0, 2)}${digest}`;
          const transit = data.transit_days[serviceLevel] ?? 3;
          const expected = new Date(ctx.now.getTime() + transit * 86_400_000);
          const shipment: Shipment = {
            tracking_number: trackingNumber,
            to,
            service_level: serviceLevel,
            booked_at: ctx.now.toISOString(),
            expected_at: expected.toISOString(),
            status: "in_transit",
          };
          shipments.set(trackingNumber, shipment);
          const body = { carrier: data.carrier, reference: String(args.reference ?? ""), ...shipment };
          return result(body, {
            source: "shipping.simulator",
            asOf: ctx.now,
            evidence: { kind: "shipping_booking", body },
          });
        },
      },

      track: {
        name: "track",
        description: "Resolves a tracking number with the carrier. An unknown number comes back not found.",
        evidenceKind: "tracking",
        input: {
          type: "object",
          properties: { tracking_number: { type: "string", description: "the tracking number to resolve" } },
          required: ["tracking_number"],
        },
        run(args, ctx) {
          const trackingNumber = String(args.tracking_number ?? "");
          const shipment = shipments.get(trackingNumber);
          const body = shipment
            ? {
                tracking_number: trackingNumber,
                found: true,
                status: shipment.cancelled ? "cancelled" : shipment.status,
                to: shipment.to,
                expected_at: shipment.expected_at,
                carrier: data.carrier,
              }
            : { tracking_number: trackingNumber, found: false, status: "not_found", carrier: data.carrier };
          return result(body, {
            source: "shipping.simulator",
            asOf: ctx.now,
            evidence: { kind: "tracking", body },
          });
        },
      },

      cancel: {
        name: "cancel",
        description: "Cancels a booking so a corrected one can be made.",
        write: true,
        evidenceKind: "shipping_cancellation",
        input: {
          type: "object",
          properties: { tracking_number: { type: "string", description: "the booking to cancel" } },
          required: ["tracking_number"],
        },
        run(args, ctx) {
          const trackingNumber = String(args.tracking_number ?? "");
          const shipment = shipments.get(trackingNumber);
          if (!shipment) throw new Error(`no shipment ${trackingNumber}`);
          shipment.cancelled = true;
          shipment.status = "cancelled";
          const body = { tracking_number: trackingNumber, status: "cancelled", cancelled_at: ctx.now.toISOString() };
          return result(body, {
            source: "shipping.simulator",
            asOf: ctx.now,
            evidence: { kind: "shipping_cancellation", body },
          });
        },
      },
    },
  });
}
