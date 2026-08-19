import os from "node:os";

const SKIP_IFACE = /virtual|vethernet|vmware|hyper-v|docker|wsl|loopback|bluetooth|isatap|teredo|pseudo|awdl|llw|utun|bridge|vbox|tun|appletalk/i;

export function lanIPv4s(): string[] {
  const found: { ip: string; score: number }[] = [];
  const ifaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs) continue;
    const skipName = SKIP_IFACE.test(name);
    for (const addr of addrs) {
      const family = String(addr.family);
      if (family !== "IPv4" && family !== "4") continue;
      if (addr.internal) continue;
      const ip = addr.address;
      if (!ip || ip.startsWith("127.") || ip.startsWith("169.254.")) continue;
      let score = 0;
      if (isPrivateIPv4(ip)) score += 10;
      if (!skipName) score += 5;
      if (/wi-?fi|wlan|ethernet|lan|en0|en1|eth|wl/i.test(name)) score += 3;
      if (ip.startsWith("192.168.")) score += 2;
      found.push({ ip, score });
    }
  }
  found.sort((a, b) => b.score - a.score);
  return [...new Set(found.map((item) => item.ip))];
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false;
  if (parts[0] === 10) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  return false;
}
