// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "dotenv";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const envPaths = [resolve(process.cwd(), ".env"), resolve(moduleDir, "..", ".env")];

for (const envPath of envPaths) {
  if (!existsSync(envPath)) {
    continue;
  }

  if (readFileSync(envPath).length === 0) {
    console.error(`Warning: ${envPath} exists but is empty. Save the file in your editor (Ctrl+S) and try again.`);
    continue;
  }

  config({ path: envPath });
  break;
}
