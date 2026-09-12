import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const GiB = 1024 ** 3;
const bytes = value => value !== null && value !== undefined && value !== '' && Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;
const remaining = (total, used) => total === null || used === null ? null : Math.max(0, total - used);

// Read-only DXGI enumeration supplies a 64-bit capacity and LUID. WMI's
// Win32_VideoController.AdapterRAM is a uint32 and truncates modern VRAM sizes.
// GPU usage comes from adapter-wide VidMm counters, never summed process usage.
// QueryVideoMemoryInfo is deliberately omitted: its budget/usage is for the
// telemetry process, not for the native renderer that will be launched later.
const windowsScript = String.raw`
$ErrorActionPreference = 'Stop'
$WarningPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$failures = @()
$ram = $null
$memory = $null
$adapters = @()
$gpuUsage = @()
try { $ram = Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize,FreePhysicalMemory } catch { $failures += 'ram-counter-unavailable' }
try { $memory = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory | Select-Object AvailableBytes,CommittedBytes,CommitLimit } catch { $failures += 'commit-counter-unavailable' }
try { $gpuUsage = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory | Select-Object Name,DedicatedUsage,SharedUsage) } catch { $failures += 'gpu-counter-unavailable' }
try {
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class YueReadOnlyDxgi {
  [StructLayout(LayoutKind.Sequential)] public struct Luid { public UInt32 Low; public Int32 High; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct Desc {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string Description;
    public UInt32 VendorId, DeviceId, SubSysId, Revision;
    public UIntPtr DedicatedVideoMemory, DedicatedSystemMemory, SharedSystemMemory;
    public Luid AdapterLuid;
  }
  public class Adapter { public string name; public string luid; public ulong totalBytes; }
  [DllImport("dxgi.dll", ExactSpelling=true)] static extern int CreateDXGIFactory(ref Guid iid, out IntPtr factory);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int EnumAdapters(IntPtr self, UInt32 index, out IntPtr adapter);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int GetDesc(IntPtr self, out Desc desc);
  static Delegate Method(IntPtr instance, int slot, Type type) {
    return Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(Marshal.ReadIntPtr(instance), slot * IntPtr.Size), type);
  }
  public static Adapter[] Read() {
    var id = new Guid("7b7166ec-21c7-44ae-b21a-c9ae321ae369");
    IntPtr factory;
    Marshal.ThrowExceptionForHR(CreateDXGIFactory(ref id, out factory));
    var result = new List<Adapter>();
    try {
      var enumerate = (EnumAdapters)Method(factory, 7, typeof(EnumAdapters));
      for (UInt32 index=0; index<32; index++) {
        IntPtr adapter;
        int hr = enumerate(factory, index, out adapter);
        if (hr == unchecked((int)0x887A0002)) break;
        Marshal.ThrowExceptionForHR(hr);
        try {
          Desc desc;
          Marshal.ThrowExceptionForHR(((GetDesc)Method(adapter, 8, typeof(GetDesc)))(adapter, out desc));
          if (desc.VendorId == 0x1414 || desc.DedicatedVideoMemory.ToUInt64() == 0) continue;
          result.Add(new Adapter { name=desc.Description, totalBytes=desc.DedicatedVideoMemory.ToUInt64(),
            luid="luid_0x" + unchecked((UInt32)desc.AdapterLuid.High).ToString("X8") + "_0x" + desc.AdapterLuid.Low.ToString("X8") });
        } finally { Marshal.Release(adapter); }
      }
    } finally { Marshal.Release(factory); }
    return result.ToArray();
  }
}
'@
$adapters = @([YueReadOnlyDxgi]::Read())
} catch { $failures += 'gpu-description-unavailable' }
@{ram=$ram; memory=$memory; adapters=$adapters; gpuUsage=$gpuUsage; failures=$failures} | ConvertTo-Json -Depth 5 -Compress
`;

const list = value => Array.isArray(value) ? value : value ? [value] : [];
function portableSnapshot(osImpl, sampledAt, errors = []) {
  const totalBytes = bytes(osImpl.totalmem()), availableBytes = bytes(osImpl.freemem());
  return {
    sampledAt, available: totalBytes !== null && availableBytes !== null, source: 'portable-os', errors,
    ram: {totalBytes, availableBytes},
    commit: {limitBytes: null, usedBytes: null, availableBytes: null},
    gpu: {name: null, luid: null, totalBytes: null, usedBytes: null, sharedBytes: null, availableBytes: null, budgetBytes: null, estimated: true, source: 'unavailable'},
  };
}

function windowsSnapshot(raw, fallback, adapterName) {
  const mibTotal = bytes(raw.ram?.TotalVisibleMemorySize);
  const mibFree = bytes(raw.ram?.FreePhysicalMemory);
  const totalBytes = mibTotal === null ? fallback.ram.totalBytes : bytes(mibTotal * 1024);
  const availableBytes = bytes(raw.memory?.AvailableBytes) ?? (mibFree === null ? fallback.ram.availableBytes : bytes(mibFree * 1024));
  const limitBytes = bytes(raw.memory?.CommitLimit), usedBytes = bytes(raw.memory?.CommittedBytes);
  const adapters = list(raw.adapters).filter(a => typeof a?.name === 'string' && typeof a?.luid === 'string' && bytes(a?.totalBytes) > 0);
  const selected = adapterName ? adapters.find(a => a.name.trim().toLowerCase() === adapterName.trim().toLowerCase()) : adapters.sort((a, b) => b.totalBytes - a.totalBytes)[0];
  let gpu = fallback.gpu;
  if (selected) {
    const matching = list(raw.gpuUsage).filter(row => typeof row?.Name === 'string' && row.Name.toLowerCase().startsWith(selected.luid.toLowerCase() + '_phys_'));
    // Linked adapters may have multiple physical nodes. Do not treat their sum
    // as the capacity of one GPU; exact available capacity then stays unknown.
    const row = matching.length === 1 ? matching[0] : null;
    const capacity = bytes(selected.totalBytes), usage = bytes(row?.DedicatedUsage);
    gpu = {name: selected.name.trim(), luid: selected.luid, totalBytes: capacity, usedBytes: usage, sharedBytes: bytes(row?.SharedUsage),
      availableBytes: remaining(capacity, usage), budgetBytes: null, estimated: true,
      source: row ? 'DXGI capacity + Windows adapter-wide dedicated usage' : 'DXGI capacity; adapter usage unavailable'};
  }
  return {...fallback, source: 'windows-cim-dxgi', errors: list(raw.failures).filter(x => typeof x === 'string'),
    ram: {totalBytes, availableBytes}, commit: {limitBytes, usedBytes, availableBytes: remaining(limitBytes, usedBytes)}, gpu};
}

/** Read-only, bounded sampler. No background timer, inference or system changes. */
export function createResourceMonitor({sampleImpl, cacheMs = 5000, timeoutMs = 8000, platform = process.platform, osImpl = os,
  execFileImpl = execFile, now = Date.now, adapterName, windowsDirectory = process.env.SystemRoot || 'C:\\Windows'} = {}) {
  let cached = null, completedAt = -Infinity, inFlight = null, adapterCache = null, adapterExpires = 0;
  async function sample() {
    const sampledAt = new Date(now()).toISOString();
    const fallback = portableSnapshot(osImpl, sampledAt);
    if (sampleImpl) {
      try { return {...await sampleImpl(), sampledAt}; }
      catch { return {...fallback, errors: ['resource-sampler-unavailable']}; }
    }
    if (platform !== 'win32') return fallback;
    try {
      // Adapter topology changes far less often than memory use. Avoid compiling
      // the small read-only DXGI helper on every polling request while gaming.
      let script = windowsScript;
      const reuseAdapters = adapterCache && now() < adapterExpires;
      if (reuseAdapters) script = script.replace(/try \{\nAdd-Type[\s\S]*?\} catch \{ \$failures \+= 'gpu-description-unavailable' \}/, '');
      const stdout = await new Promise((resolve, reject) => execFileImpl(
        path.win32.join(windowsDirectory, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        {windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024, encoding: 'utf8'},
        (error, output) => error ? reject(error) : resolve(output)));
      const raw = JSON.parse(String(stdout).replace(/^\uFEFF/, '').trim());
      if (reuseAdapters) raw.adapters = adapterCache;
      else {
        const candidates = list(raw.adapters).filter(a => typeof a?.name === 'string' && typeof a?.luid === 'string' && bytes(a?.totalBytes) > 0);
        if (candidates.length) {adapterCache = candidates; adapterExpires = now() + 300000;}
      }
      return windowsSnapshot(raw, fallback, adapterName);
    } catch { return {...fallback, errors: ['windows-resource-counters-unavailable']}; }
  }
  return {
    async read({fresh = false} = {}) {
      if (inFlight) return structuredClone(await inFlight);
      if (!fresh && cached && now() - completedAt < cacheMs) return structuredClone(cached);
      inFlight = sample().then(value => {cached = value; completedAt = now(); return value;});
      try { return structuredClone(await inFlight); } finally { inFlight = null; }
    },
  };
}

/** Advisory preflight, not a reservation or a guarantee of future allocations.
 * Requirements are policy estimates; callers may supply measured profile values.
 * A known shortfall wins over missing telemetry. Missing telemetry never says ready.
 */
export function assessResources(snapshot, request = {}, {requirements: overrides = {}, now = Date.now(), maxAgeMs = 30000} = {}) {
  const tokenCap = Number(request.semantic_max_tokens);
  const duration = Number.isFinite(tokenCap) && tokenCap > 0 ? tokenCap / 25 : Infinity;
  const shortRender = duration <= 60, mediumRender = duration <= 120;
  const originalStorageMargin = request.weight_storage === 'native' ? 2 : 0;
  const requirements = {
    ramBytes: 0.75 * GiB,
    commitBytes: (shortRender ? 7 : 8) * GiB,
    gpuBytes: request.backend === 'cpu' ? 0 : ((shortRender ? 6 : mediumRender ? 8.5 : 10.5) + originalStorageMargin) * GiB,
    estimated: true,
    basis: shortRender
      ? 'Estimate with margin over a measured 12-second Q8 render with 256 MiB metadata arenas: +5.46 GiB system commit and +4.07 GiB dedicated GPU use. Longer scores may need more.'
      : 'Conservative estimate for long Q8 renders with 256 MiB metadata arenas. Duration and generated score affect allocations; this is not a memory reservation or guaranteed budget.',
    ...overrides,
  };
  const reasons = [], unknown = [];
  if (!snapshot || !Number.isFinite(Date.parse(snapshot.sampledAt)) || now - Date.parse(snapshot.sampledAt) > maxAgeMs) {
    return {state: 'unknown', reasons: ['Current memory readings are unavailable.'], requirements};
  }
  for (const [label, available, required] of [
    ['System RAM', bytes(snapshot.ram?.availableBytes), bytes(requirements.ramBytes)],
    ['Windows commit headroom', bytes(snapshot.commit?.availableBytes), bytes(requirements.commitBytes)],
    ['GPU memory', bytes(snapshot.gpu?.availableBytes), bytes(requirements.gpuBytes)],
  ]) {
    if (required === 0) continue;
    if (available === null || required === null) {unknown.push(`${label} could not be measured.`); continue;}
    if (available < required) reasons.push(`${label}: ${(available / GiB).toFixed(1)} GiB available; approximately ${(required / GiB).toFixed(1)} GiB requested by the memory policy.`);
  }
  return {state: reasons.length ? 'waiting' : unknown.length ? 'unknown' : 'ready', reasons: [...reasons, ...unknown], requirements};
}
