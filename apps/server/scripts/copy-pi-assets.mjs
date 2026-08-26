import { copyFile, mkdir } from "node:fs/promises";
import { dirname, fileURLToPath } from "node:path";

const source = fileURLToPath(new URL("../src/provider/assets/pi/t3-approvals.ts", import.meta.url));
const target = fileURLToPath(new URL("../dist/assets/pi/t3-approvals.ts", import.meta.url));

await mkdir(dirname(target), { recursive: true });
await copyFile(source, target);
