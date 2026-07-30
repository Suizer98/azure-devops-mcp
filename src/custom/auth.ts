// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { logger } from "../logger.js";
import { readNtlmCredentialsFromEnvironment } from "../ntlm-auth.js";
import { getCurrentNtlmCredentials } from "../request-context.js";

/**
 * Custom authenticator factory. Handles NTLM, then delegates to Microsoft createAuthenticator.
 */
export function createCustomAuthenticator(type: string, tenantId?: string): () => Promise<string> {
  if (type === "ntlm") {
    logger.debug(`Authenticator: Using NTLM authentication for on-prem domain credentials`);
    return async () => {
      const credentials = getCurrentNtlmCredentials() ?? readNtlmCredentialsFromEnvironment();
      logger.debug(`ntlm: Loaded NTLM credentials`, {
        username: credentials.domain ? `${credentials.domain}\\${credentials.username}` : credentials.username,
      });
      return "ntlm";
    };
  }

  // Imported on demand: ../auth.js pulls in the MSAL broker's native modules (keytar,
  // msal-node-runtime), which are absent in headless deployments such as the container.
  let microsoftAuthenticator: (() => Promise<string>) | undefined;
  return async () => {
    if (!microsoftAuthenticator) {
      const { createAuthenticator } = await import("../auth.js");
      microsoftAuthenticator = createAuthenticator(type, tenantId);
    }
    return microsoftAuthenticator();
  };
}
