/**
 * Fail-fast preflight for the `gondolin` execution sandbox.
 *
 * gondolin boots a QEMU micro-VM per task to isolate the agent's bash/file
 * tools from the host. QEMU needs hardware acceleration, and its worst failure
 * mode is a **silent hang** (upstream #51): without acceleration the guest CPU
 * never finishes booting and the run wedges instead of erroring. So we probe the
 * two documented traps up front and abort with actionable guidance rather than
 * trusting the VM's "ready" signal:
 *
 *   - **macOS** uses Apple's Hypervisor.framework (HVF) automatically — no
 *     `/dev/kvm`. The only trap is running the orchestrator *inside* a container
 *     (Colima / Docker Desktop expose no `/dev/kvm`, so gondolin hangs).
 *   - **Linux** uses KVM: an accessible `/dev/kvm` is required.
 *
 * This is best-effort: it can't prove the guest will boot without actually
 * booting one (the ~13s cost we're avoiding here), but it catches the misconfigs
 * that otherwise present as a hang. See `~/work/agentic-pi/SPIKE-gondolin.md`.
 */

import { existsSync, accessSync, readFileSync, constants } from "node:fs";
import { execFileSync } from "node:child_process";
import { arch, platform } from "node:process";

export interface PreflightResult {
  ok: boolean;
  /** Actionable error to print when `ok` is false (empty when ok). */
  message: string;
}

/** QEMU's system binary is named per target arch; gondolin boots a guest
 * matching the host arch. */
function qemuBinaryForArch(): string {
  return arch === "arm64" ? "qemu-system-aarch64" : "qemu-system-x86_64";
}

function onPath(bin: string): boolean {
  try {
    execFileSync(platform === "win32" ? "where" : "which", [bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Best-effort: are we running inside a container (where macOS/Colima exposes no
 * `/dev/kvm` and gondolin hangs)? */
function looksContainerized(): boolean {
  if (existsSync("/.dockerenv")) return true;
  try {
    const cgroup = readFileSync("/proc/1/cgroup", "utf8");
    return /docker|containerd|kubepods|lxc/.test(cgroup);
  } catch {
    // No /proc (e.g. native macOS) → not containerized.
    return false;
  }
}

/**
 * Verify the host can run the requested sandbox backend. Only `gondolin` needs
 * checking; every other backend (including `none`) returns ok. Call once, before
 * launching any instance.
 */
export function preflightSandbox(backend: string): PreflightResult {
  if (backend !== "gondolin") return { ok: true, message: "" };

  const qemu = qemuBinaryForArch();
  if (!onPath(qemu)) {
    return {
      ok: false,
      message:
        `--sandbox gondolin needs QEMU (${qemu}) on PATH, but it wasn't found. ` +
        `Install it: 'brew install qemu' (macOS) or 'apt-get install qemu-system' (Linux). ` +
        `Or run with --sandbox none.`,
    };
  }

  if (platform === "darwin") {
    // Native macOS uses HVF automatically. The trap is running inside a
    // container on macOS — no /dev/kvm is exposed and gondolin hangs silently.
    if (looksContainerized()) {
      return {
        ok: false,
        message:
          `--sandbox gondolin: running inside a container on macOS exposes no /dev/kvm, ` +
          `so gondolin hangs silently rather than erroring. Run the eval natively on the ` +
          `macOS host, or use --sandbox none.`,
      };
    }
    return { ok: true, message: "" };
  }

  if (platform === "linux") {
    if (!existsSync("/dev/kvm")) {
      return {
        ok: false,
        message:
          `--sandbox gondolin needs /dev/kvm (KVM hardware acceleration), but it's missing. ` +
          `Without it the VM hangs silently instead of erroring. Run on a KVM-capable host ` +
          `(managed container hosts like Fargate/Cloud Run don't expose it), or use --sandbox none.`,
      };
    }
    try {
      accessSync("/dev/kvm", constants.R_OK | constants.W_OK);
    } catch {
      return {
        ok: false,
        message:
          `--sandbox gondolin: /dev/kvm exists but isn't readable/writable by this user. ` +
          `Add your user to the 'kvm' group (or grant access), or use --sandbox none.`,
      };
    }
    return { ok: true, message: "" };
  }

  return {
    ok: false,
    message: `--sandbox gondolin isn't supported on platform "${platform}". Use --sandbox none.`,
  };
}
