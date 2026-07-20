import { activatePi, type PiExtensionAPI } from "./pi.ts";

export default async function omniroutePiExtension(api: PiExtensionAPI): Promise<void> {
  await activatePi(api);
}
