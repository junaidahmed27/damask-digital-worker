import { fixture } from "@/lib/fixtures";
import { defineConnector, result, type Connector } from "../kit";

type MdmFixture = {
  catalogue: Record<string, { sku: string; in_stock: number; weight_kg: number }>;
  images: Record<string, string>;
};

/** The device manager. Orders a laptop and returns the asset it allocated. */
export function createMdmSimulator(fixturePath = "day_one/mdm.json"): Connector {
  const data = fixture<MdmFixture>(fixturePath);
  const stock = Object.fromEntries(Object.entries(data.catalogue).map(([k, v]) => [k, v.in_stock]));
  let serial = 4100;

  return defineConnector({
    id: "mdm",
    kind: "mdm",
    impl: "simulator",
    capabilities: { read: true, write: true, asOf: false, webhook: false },
    dataPolicy: "allowed",
    ops: {
      order_device: {
        name: "order_device",
        description:
          "Allocates a device of the model the role profile names and returns the asset tag, serial number and weight for shipping.",
        write: true,
        evidenceKind: "device_order",
        input: {
          type: "object",
          properties: {
            model: { type: "string", description: "the model from the role profile, for example macbook-pro-14" },
            for_worker: { type: "string", description: "the worker id" },
            role_profile: { type: "string", description: "the role profile name, used to pick the image" },
          },
          required: ["model", "for_worker"],
        },
        run(args, ctx) {
          const model = String(args.model ?? "");
          const item = data.catalogue[model];
          if (!item) throw new Error(`no device model ${model}`);
          if ((stock[model] ?? 0) <= 0) throw new Error(`${model} is out of stock`);
          stock[model] = (stock[model] ?? 0) - 1;
          serial += 1;
          const body = {
            model,
            sku: item.sku,
            asset_tag: `AST-${serial}`,
            serial_number: `C02${serial}XYZ`,
            weight_kg: item.weight_kg,
            image: data.images[String(args.role_profile ?? "")] ?? "corp-macos-2026.3",
            for_worker: String(args.for_worker ?? ""),
            ordered_at: ctx.now.toISOString(),
          };
          return result(body, {
            source: "mdm.simulator",
            asOf: ctx.now,
            evidence: { kind: "device_order", body },
          });
        },
      },

      get_device: {
        name: "get_device",
        description: "Looks up a device by asset tag.",
        evidenceKind: "device_record",
        input: {
          type: "object",
          properties: { asset_tag: { type: "string", description: "the asset tag" } },
          required: ["asset_tag"],
        },
        run(args, ctx) {
          const body = { asset_tag: String(args.asset_tag ?? ""), status: "allocated" };
          return result(body, {
            source: "mdm.simulator",
            asOf: ctx.now,
            evidence: { kind: "device_record", body },
          });
        },
      },
    },
  });
}
