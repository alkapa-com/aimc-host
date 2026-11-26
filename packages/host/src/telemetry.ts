import { execFile } from "node:child_process";

// GPU telemetry from nvidia-smi, when it's installed (NVIDIA drivers ship it on Windows and
// Linux). One fixed command with fixed arguments: nothing from the server is ever run.

export interface GpuTelemetry {
  name: string;
  vramTotalMb: number;
  vramUsedMb: number;
  utilizationPct: number;
  temperatureC: number;
}

/** Parses `nvidia-smi --query-gpu=... --format=csv,noheader,nounits` (the first GPU). */
export function parseNvidiaSmi(output: string): GpuTelemetry | null {
  const line = output.split(/\r?\n/).find((l) => l.trim());
  if (!line) return null;
  const parts = line.split(",").map((p) => p.trim());
  if (parts.length < 5) return null;
  const [name, total, used, util, temp] = parts;
  const numbers = [total, used, util, temp].map((v) => Number(v));
  if (!name || numbers.some((n) => !Number.isFinite(n))) return null;
  const [vramTotalMb, vramUsedMb, utilizationPct, temperatureC] = numbers as [number, number, number, number];
  return {
    name: name.slice(0, 100),
    vramTotalMb: Math.round(vramTotalMb),
    vramUsedMb: Math.round(vramUsedMb),
    utilizationPct: Math.min(100, Math.max(0, utilizationPct)),
    temperatureC,
  };
}

export function readGpu(): Promise<GpuTelemetry | null> {
  return new Promise((resolve) => {
    execFile(
      "nvidia-smi",
      ["--query-gpu=name,memory.total,memory.used,utilization.gpu,temperature.gpu", "--format=csv,noheader,nounits"],
      { timeout: 3000, windowsHide: true },
      (err, stdout) => resolve(err ? null : parseNvidiaSmi(stdout)),
    );
  });
}
