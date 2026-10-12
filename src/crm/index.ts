import type { AppConfig, CrmName } from "../config.js";
import { FileAdapter, NoopAdapter } from "./file.js";
import { HubSpotAdapter } from "./hubspot.js";
import { TwentyAdapter } from "./twenty.js";
import type { CrmAdapter } from "./types.js";

export function createCrmAdapter(name: CrmName, cfg: AppConfig): CrmAdapter {
  switch (name) {
    case "twenty":
      return new TwentyAdapter(cfg.twenty);
    case "hubspot":
      return new HubSpotAdapter(cfg.hubspot);
    case "file":
      return new FileAdapter(cfg.outDir);
    case "none":
      return new NoopAdapter();
  }
}

export * from "./types.js";
export { TwentyAdapter, HubSpotAdapter, FileAdapter, NoopAdapter };
