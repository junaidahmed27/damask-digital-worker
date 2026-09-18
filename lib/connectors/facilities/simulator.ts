import { fixture } from "@/lib/fixtures";
import { defineConnector, result, type Connector } from "../kit";

type FacilitiesFixture = {
  buildings: Record<string, { name: string; badge_office: string; zones: string[] }>;
  desks: Record<string, string[]>;
  assigned: Record<string, string[]>;
};

/** Badges and desks. The calendar op lives here too, since it is the same team. */
export function createFacilitiesSimulator(fixturePath = "day_one/facilities.json"): Connector {
  const data = fixture<FacilitiesFixture>(fixturePath);
  const assigned: Record<string, string[]> = structuredClone(data.assigned);
  let badgeSeq = 700;

  return defineConnector({
    id: "facilities",
    kind: "facilities",
    impl: "simulator",
    capabilities: { read: true, write: true, asOf: false, webhook: false },
    dataPolicy: "allowed",
    ops: {
      request_badge: {
        name: "request_badge",
        description: "Requests a building badge for the worker and returns the badge number and collection point.",
        write: true,
        evidenceKind: "badge_request",
        input: {
          type: "object",
          properties: {
            worker: { type: "string", description: "the worker id" },
            building: { type: "string", description: "the building id, for example austin-2" },
          },
          required: ["worker", "building"],
        },
        run(args, ctx) {
          const buildingId = String(args.building ?? "");
          const building = data.buildings[buildingId];
          if (!building) throw new Error(`no building ${buildingId}`);
          badgeSeq += 1;
          const body = {
            worker: String(args.worker ?? ""),
            building: buildingId,
            badge_number: `BDG-${badgeSeq}`,
            collect_at: building.badge_office,
            requested_at: ctx.now.toISOString(),
          };
          return result(body, {
            source: "facilities.simulator",
            asOf: ctx.now,
            evidence: { kind: "badge_request", body },
          });
        },
      },

      assign_desk: {
        name: "assign_desk",
        description: "Assigns the next free desk in the zone the role profile names.",
        write: true,
        evidenceKind: "desk_assignment",
        input: {
          type: "object",
          properties: {
            worker: { type: "string", description: "the worker id" },
            zone: { type: "string", description: "the desk zone, for example austin-2-east" },
          },
          required: ["worker", "zone"],
        },
        run(args, ctx) {
          const zone = String(args.zone ?? "");
          const all = data.desks[zone];
          if (!all) throw new Error(`no desk zone ${zone}`);
          const taken = assigned[zone] ?? [];
          const free = all.find((desk) => !taken.includes(desk));
          if (!free) throw new Error(`no free desk in ${zone}`);
          assigned[zone] = [...taken, free];
          const body = {
            worker: String(args.worker ?? ""),
            zone,
            desk: free,
            assigned_at: ctx.now.toISOString(),
          };
          return result(body, {
            source: "facilities.simulator",
            asOf: ctx.now,
            evidence: { kind: "desk_assignment", body },
          });
        },
      },

      send_invites: {
        name: "send_invites",
        description:
          "Sends the first week calendar invites to the worker and returns each invite with whether it was accepted.",
        write: true,
        evidenceKind: "calendar_invites",
        input: {
          type: "object",
          properties: {
            worker: { type: "string", description: "the worker id" },
            titles: { type: "array", items: { type: "string" }, description: "the meeting titles" },
          },
          required: ["worker"],
        },
        run(args, ctx) {
          const titles = ((args.titles as string[] | undefined) ?? [
            "Welcome and laptop setup",
            "Team standup",
            "Product walkthrough",
            "First customer shadow",
            "End of week one check in",
          ]).slice(0, 8);
          const body = {
            worker: String(args.worker ?? ""),
            sent_at: ctx.now.toISOString(),
            invites: titles.map((title) => ({ title, accepted: true })),
          };
          return result(body, {
            source: "facilities.simulator",
            asOf: ctx.now,
            evidence: { kind: "calendar_invites", body },
          });
        },
      },
    },
  });
}
