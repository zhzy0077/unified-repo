import { respond } from './core';
import type { AppContext } from './core';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const ctx: AppContext = {
      GITHUB_TOKEN: env.GITHUB_TOKEN,
      RPM_METADATA: env.RPM_METADATA,
      PUBLIC_ORIGIN: env.PUBLIC_ORIGIN,
    };
    return respond(request, ctx);
  }
} satisfies ExportedHandler<Env>;
