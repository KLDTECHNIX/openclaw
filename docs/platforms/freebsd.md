---
title: FreeBSD
description: Running FreeClaw on FreeBSD
---

# FreeBSD

FreeClaw is purpose-built for FreeBSD. It uses native FreeBSD tooling throughout:

- **Service management**: rc.d scripts via `service(8)` and `sysrc(8)`
- **Process introspection**: `procstat(1)` and `ps(1)` (no /proc dependency)
- **Port inspection**: `sockstat(1)` (not lsof)
- **Daemon management**: `daemon(8)` for background processes
- **Jail support**: `jail(8)` for isolated deployment with automated setup
- **System tuning**: `sysctl(8)`, `loader.conf(5)`, `rc.conf(5)` via interactive wizard
- **PID files**: `/var/run/freeclaw_gateway.pid`
- **Logs**: `/var/log/freeclaw_gateway.log`

## Prerequisites

Install Node.js 22+ and npm via pkg:

```sh
pkg install node22 npm-node22
```

## Install FreeClaw

```sh
npm install -g freeclaw
```

## Quick Start

```sh
freeclaw onboard
```

This walks through initial configuration and optionally installs the gateway as an rc.d service.

## System Tuning

FreeClaw includes an interactive tuning wizard that configures the host FreeBSD system for optimal gateway performance.

```sh
freeclaw tune
```

The wizard covers four areas:

### Kernel tuning (sysctl.conf)

Runtime-tunable knobs optimized for a long-running Node.js gateway with many concurrent WebSocket/TCP connections:

| Knob | Value | Purpose |
|------|-------|---------|
| `kern.maxfiles` | 131072 | System-wide fd limit (Node uses one fd per socket) |
| `kern.maxfilesperproc` | 104856 | Per-process fd limit |
| `kern.ipc.somaxconn` | 4096 | Listen backlog (prevents SYN drops under burst) |
| `kern.ipc.maxsockbuf` | 4194304 | Max socket buffer (4 MB ceiling) |
| `net.inet.tcp.sendbuf_max` | 2097152 | Max TCP send buffer (2 MB) |
| `net.inet.tcp.recvbuf_max` | 2097152 | Max TCP recv buffer (2 MB) |
| `net.inet.tcp.sendspace` | 65536 | Default per-socket send buffer (64 KB) |
| `net.inet.tcp.recvspace` | 65536 | Default per-socket recv buffer (64 KB) |
| `net.inet.tcp.fast_finwait2_recycle` | 1 | Faster FIN_WAIT_2 cleanup |
| `net.inet.tcp.finwait2_timeout` | 5000 | 5s FIN_WAIT_2 timeout (default 60s) |
| `net.inet.tcp.nolocaltimewait` | 1 | Skip TIME_WAIT for loopback |
| `net.inet.tcp.cc.algorithm` | cubic | Modern congestion control for WAN |
| `net.inet.tcp.msl` | 5000 | Faster TIME_WAIT expiry |
| `net.inet.tcp.blackhole` | 2 | Stealth drop on closed TCP ports |
| `net.inet.udp.blackhole` | 1 | Drop on closed UDP ports |
| `net.inet.tcp.drop_synfin` | 1 | Mitigate OS fingerprinting |
| `net.inet.ip.redirect` | 0 | Ignore ICMP redirects |
| `security.bsd.unprivileged_proc_debug` | 0 | Harden process debugging |

Apply at runtime:

```sh
sysctl kern.ipc.somaxconn=4096
```

Or persist in `/etc/sysctl.conf` (the wizard does both).

### Boot tuning (loader.conf)

Kernel modules and boot-time tunables for `/boot/loader.conf`:

| Tunable | Value | Purpose |
|---------|-------|---------|
| `accf_http_load` | YES | Accept filter for HTTP (kernel-level) |
| `accf_data_load` | YES | Accept filter for data connections |
| `cc_cubic_load` | YES | CUBIC congestion control module |
| `aesni_load` | YES | Hardware AES acceleration |
| `kern.ipc.semmni` | 256 | Semaphore sets (IPC) |
| `kern.ipc.semmns` | 1024 | Semaphore count |
| `hw.ibrs_disable` | 1 | Disable Spectre mitigations (perf trade-off) |
| `kern.random.fortuna.minpoolsize` | 128 | Faster entropy for TLS |

Changes require a reboot to take effect.

### Service configuration (rc.conf)

Recommended `rc.conf(5)` entries applied via `sysrc(8)`:

```sh
# FreeClaw gateway service
sysrc freeclaw_gateway_enable=YES
sysrc freeclaw_gateway_logfile=/var/log/freeclaw_gateway.log

# System hardening
sysrc clear_tmp_enable=YES
sysrc syslogd_flags="-ss"
sysrc sendmail_enable=NO
sysrc sendmail_submit_enable=NO
sysrc sendmail_outbound_enable=NO
sysrc sendmail_msp_queue_enable=NO
sysrc dumpdev=NO

# Network
sysrc tcp_keepalive=YES
```

### Wizard modes

```sh
# Full interactive setup (default)
freeclaw tune --mode full

# Tune sysctl/loader/rc.conf only (no jail)
freeclaw tune --mode tune-only

# Jail creation only
freeclaw tune --mode jail-only

# Audit current state (read-only, no changes)
freeclaw tune --mode audit
```

## Gateway Service

### Install as rc.d service

```sh
freeclaw gateway install
```

This creates `/usr/local/etc/rc.d/freeclaw_gateway` and enables it via `sysrc`.

### Manual service management

```sh
# Start
service freeclaw_gateway start

# Stop
service freeclaw_gateway stop

# Restart
service freeclaw_gateway restart

# Status
service freeclaw_gateway status
```

### Enable at boot

The installer runs this automatically, but you can also do it manually:

```sh
sysrc freeclaw_gateway_enable=YES
```

### Configuration

The rc.d service supports these rc.conf variables:

```sh
freeclaw_gateway_enable="YES"        # Enable the service
freeclaw_gateway_user="root"         # User to run as
freeclaw_gateway_pidfile="/var/run/freeclaw_gateway.pid"
freeclaw_gateway_logfile="/var/log/freeclaw_gateway.log"
```

## Running in a Jail

FreeClaw includes automated jail creation via the tuning wizard:

```sh
freeclaw tune --mode jail-only
```

The wizard will:

1. Prompt for jail name, IP address, and gateway port
2. Extract a FreeBSD base from `base.txz` (fetched if needed)
3. Bootstrap `pkg(8)` inside the jail
4. Install `node22` and `freeclaw` in the jail
5. Generate `/etc/jail.conf` stanza and fstab
6. Optionally enable the jail at boot via `rc.conf`

### Manual jail setup

For manual jail environments:

1. Ensure the jail has network access
2. Install Node.js inside the jail: `pkg install node22`
3. Run the gateway in the foreground if rc.d is not available:

```sh
freeclaw gateway run --bind loopback --port 18789
```

### Jail networking

The wizard uses `lo1` cloned loopback with alias IPs in the `127.0.1.x` range:

```sh
# Create lo1 at boot
sysrc cloned_interfaces="lo1"

# Add jail IP alias
ifconfig lo1 alias 127.0.1.1/32
```

### Enable jails at boot

```sh
sysrc jail_enable=YES
sysrc jail_parallel_start=YES
sysrc jail_list="freeclaw"
```

## Paths

| Path | Purpose |
|------|---------|
| `~/.freeclaw/` | State directory (config, sessions, caches) |
| `~/.freeclaw/freeclaw.json` | Configuration file |
| `/usr/local/etc/rc.d/freeclaw_gateway` | rc.d service script |
| `/var/run/freeclaw_gateway.pid` | PID file |
| `/var/log/freeclaw_gateway.log` | Service log |
| `/etc/jail.conf` | Jail configuration (if using jails) |
| `/etc/sysctl.conf` | Persistent sysctl tuning |
| `/boot/loader.conf` | Boot-time kernel tuning |

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `FREECLAW_STATE_DIR` | Override state directory |
| `FREECLAW_CONFIG_PATH` | Override config file path |
| `FREECLAW_GATEWAY_PORT` | Override gateway port (default: 18789) |
| `FREECLAW_PROFILE` | Named profile for multiple instances |
| `FREECLAW_RCD_SERVICE` | Override rc.d service name |

## Troubleshooting

### Check service status

```sh
service freeclaw_gateway status
sockstat -4 -l -p 18789
```

### View logs

```sh
tail -f /var/log/freeclaw_gateway.log
```

### Run diagnostics

```sh
freeclaw doctor
```

### Audit system tuning

```sh
freeclaw tune --mode audit
```

This shows the current values of all recommended sysctl, loader.conf, and rc.conf knobs compared to recommended values, without making any changes.
