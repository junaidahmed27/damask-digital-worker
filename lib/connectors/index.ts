import { createChatSimulator } from "./chat/simulator";
import { createSlackConnector, slackConfigFromEnv } from "./chat/slack";
import { createDocsSimulator } from "./docs/simulator";
import { createGoogleDocsConnector } from "./docs/google";
import { createFacilitiesSimulator } from "./facilities/simulator";
import { createFilesSimulator } from "./files/simulator";
import { createHrisSimulator } from "./hris/simulator";
import { createWorkdayConnector, workdayConfigFromEnv } from "./hris/workday";
import { createIdpSimulator } from "./idp/simulator";
import { createOktaConnector, oktaConfigFromEnv } from "./idp/okta";
import { ConnectorRegistry, type Connector } from "./kit";
import { createMailSandbox } from "./mail/sandbox";
import { createMdmSimulator } from "./mdm/simulator";
import { createShippingSimulator } from "./shipping/simulator";

export type RegistryOptions = {
  /** Forces every connector to its simulator, whatever the environment holds. */
  simulatorsOnly?: boolean;
  dataDir?: string;
};

/**
 * Builds the registry for this process. A vendor implementation is wired in only
 * when its credentials are present; otherwise the simulator with the identical
 * ops takes its place, which is what lets the demo run end to end with nothing
 * configured and a pilot swap in one real system at a time.
 */
export function createRegistry(options: RegistryOptions = {}): ConnectorRegistry {
  const dataDir = options.dataDir ?? process.env.LEDGER_DATA_DIR ?? ".ledger-data";
  const simulatorsOnly = options.simulatorsOnly === true;

  const workday = simulatorsOnly ? null : workdayConfigFromEnv();
  const okta = simulatorsOnly ? null : oktaConfigFromEnv();
  const slack = simulatorsOnly ? null : slackConfigFromEnv();
  const googleJson = simulatorsOnly ? undefined : process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

  const connectors: Connector[] = [
    workday ? createWorkdayConnector(workday) : createHrisSimulator(),
    okta ? createOktaConnector(okta) : createIdpSimulator(),
    createMdmSimulator(),
    createShippingSimulator(),
    createFacilitiesSimulator(),
    createFilesSimulator(),
    slack ? createSlackConnector(slack) : createChatSimulator(),
    googleJson
      ? createGoogleDocsConnector({
          serviceAccountJson: googleJson,
          templateId: process.env.GOOGLE_DOC_TEMPLATE_ID,
        })
      : createDocsSimulator(`${dataDir}/docs`),
    createMailSandbox(`${dataDir}/mail`),
  ];

  return new ConnectorRegistry().register(...connectors);
}

let shared: ConnectorRegistry | undefined;

export function registry(): ConnectorRegistry {
  shared ??= createRegistry();
  return shared;
}

/** Test and demo seam: replaces the process wide registry. */
export function setRegistry(next: ConnectorRegistry | undefined): void {
  shared = next;
}

export * from "./kit";
