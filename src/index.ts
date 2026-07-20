import { activateOmp, type OmpExtensionAPI } from "./omp.ts";

export default async function omnirouteExtension(api: OmpExtensionAPI): Promise<void> {
  await activateOmp(api);
}
