// Classify what a run will do so we can ask for a deliberate confirmation
// (a "second approval") before anything that modifies or could destroy state.
import type { ActionId } from './deployForm'
import type { CustomScriptState } from './CustomScriptPanel'
import type { ThreecxState } from '../threecx/threecxModel'

export type RiskLevel = 'read-only' | 'modifies' | 'destructive'

export interface RiskAssessment {
  level: RiskLevel
  title: string
  /** One-line plain description of what the run will do. */
  summary: string
  /** Optional specifics (changed fields, destructive patterns found, etc.). */
  details: string[]
}

// Heuristic patterns that flag an arbitrary custom script as potentially
// destructive. Not exhaustive — a deliberate confirmation backstops it.
const DESTRUCTIVE_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /\brm\s+-[a-z]*[rf]/i, label: 'rm -rf (recursive delete)' },
  { re: /\bmkfs\b/i, label: 'mkfs (format a filesystem)' },
  { re: /\bdd\b[^\n]*\bof=/i, label: 'dd (raw disk write)' },
  { re: />\s*\/dev\/(sd|nvme|disk|hd)/i, label: 'write to a block device' },
  { re: /\b(reboot|shutdown|halt|poweroff|init\s+0|init\s+6)\b/i, label: 'reboot / shutdown' },
  { re: /\bwipefs\b/i, label: 'wipefs' },
  { re: /:\s*\(\s*\)\s*\{[^}]*\}\s*;/, label: 'fork bomb' },
  { re: /\b(userdel|deluser|groupdel)\b/i, label: 'delete a user/group' },
  { re: /\bdrop\s+(database|table)\b/i, label: 'drop database/table' },
  { re: /\biptables\s+-F\b/i, label: 'flush firewall rules' },
]

// Commands/redirects that change state — if none of these (and nothing
// destructive) appear, we treat a custom script as read-only.
const MUTATING_PATTERNS: RegExp[] = [
  /\b(cp|mv|rm|rmdir|mkdir|touch|ln|chmod|chown|chgrp|tee|install|truncate|patch)\b/i,
  /\bsed\b[^\n]*-i/i,
  /\b(apt|apt-get|aptitude|dpkg|yum|dnf|rpm|zypper|pacman|snap|pip|pip3|npm|gem|cargo)\s+(install|remove|update|upgrade|purge|add|uninstall)\b/i,
  /\b(systemctl|service|rc-service)\s+(start|stop|restart|reload|enable|disable|mask)\b/i,
  /\b(useradd|adduser|usermod|userdel|deluser|passwd|groupadd|groupdel)\b/i,
  /\bcrontab\b/i,
  /\b(iptables|nft|ufw|firewall-cmd)\b/i,
  /\bgit\s+(push|commit|reset|clean|checkout|merge|rebase)\b/i,
  /\b(kill|killall|pkill)\b/i,
  // redirect to a real file (not >/dev/null, not 2>&1)
  />>?\s*(?!&)(?!\/dev\/(null|stdout|stderr)\b)[\w./~$-]+/,
]

// RouterOS (MikroTik) equivalents — the POSIX patterns above don't apply to
// the RouterOS console, so dangerous RouterOS commands need their own list.
const ROUTEROS_DESTRUCTIVE: { re: RegExp; label: string }[] = [
  { re: /reset-configuration/i, label: 'reset-configuration (factory reset)' },
  { re: /\/system\s+(reboot|shutdown)/i, label: '/system reboot / shutdown' },
  { re: /\/system\s+reset\b/i, label: '/system reset' },
  { re: /(^|[\s;/])remove\b/i, label: 'remove (deletes config items)' },
  { re: /\/file\s+remove/i, label: '/file remove' },
  { re: /(^|[\s;/])(format|downgrade)\b/i, label: 'format / downgrade' },
  { re: /(^|[\s;/])upgrade\b/i, label: 'upgrade (firmware — reboots)' },
]
// Broad on purpose: RouterOS has many state-changing verbs beyond set/add, so
// anything that isn't plainly read-only (print/get/export/find/monitor) should
// still ask for confirmation. The boundary includes `/` so top-level commands
// like `/import` are caught, not just space-preceded verbs.
const ROUTEROS_MUTATING: RegExp[] = [
  /(^|[\s;/])(set|add|enable|disable|move|unset|install|import|run|sign|edit|make-static|activate|deactivate|renew|release|schedule|unschedule|reboot)\b/i,
]

function scriptContent(cs: CustomScriptState): string {
  return cs.source === 'library' ? cs.library.content : cs.source === 'paste' ? cs.paste : cs.upload.content
}

export function assessRisk(action: ActionId, threecx: ThreecxState, customScript: CustomScriptState): RiskAssessment {
  switch (action) {
    case 'quick_diag':
      return { level: 'read-only', title: 'Quick diagnostic', summary: 'Read-only health snapshot — nothing on the systems is changed.', details: [] }

    case 'deploy':
      return { level: 'modifies', title: 'Deploy heplify', summary: 'Installs/upgrades the heplify capture agent and starts its service on each system.', details: [] }

    case 'apt_upgrade':
      return { level: 'modifies', title: 'Apt upgrade', summary: 'Updates and upgrades packages. No reboot and no service restarts.', details: [] }

    case 'custom_script': {
      const content = scriptContent(customScript)
      const ros = customScript.interpreter === 'routeros'
      const destructivePatterns = ros ? ROUTEROS_DESTRUCTIVE : DESTRUCTIVE_PATTERNS
      const mutatingPatterns = ros ? ROUTEROS_MUTATING : MUTATING_PATTERNS
      const hits = destructivePatterns.filter((p) => p.re.test(content)).map((p) => `⚠ ${p.label}`)
      const root = !ros && customScript.rootMode !== 'none' // su doesn't apply to RouterOS
      if (hits.length) {
        const details = [...hits]
        if (root) details.push('Runs as root via su escalation.')
        return { level: 'destructive', title: 'Custom script', summary: 'This script contains commands that can be destructive. Review it carefully before running.', details }
      }
      if (!mutatingPatterns.some((re) => re.test(content))) {
        return { level: 'read-only', title: 'Custom script', summary: 'This script looks read-only — no file writes or system-changing commands were detected.', details: [] }
      }
      return { level: 'modifies', title: 'Custom script', summary: 'Runs your script on each system — it writes files or changes system state.', details: root ? ['Runs as root via su escalation.'] : [] }
    }

    case 'threecx': {
      const op = threecx.operation
      if (op === 'audit' || op === 'probe' || op === 'export' || op === 'quickactions') {
        return { level: 'read-only', title: `3CX ${op === 'quickactions' ? 'quick actions' : op}`, summary: 'Read-only — reads PBX configuration and changes nothing.', details: [] }
      }
      if (op === 'import') {
        const mirror = threecx.strategy === 'mirror'
        return {
          level: mirror ? 'destructive' : 'modifies',
          title: '3CX import',
          summary: mirror
            ? 'Mirror import — creates, patches, AND DELETES items on the target that are missing from the source file.'
            : `Import (${threecx.strategy}) — applies the configuration file to each PBX.`,
          details: [],
        }
      }
      // modify / apply
      const fields = threecx.panels.flatMap((p) => [
        ...Object.entries(p.fields).filter(([, s]) => s.checked).map(([f]) => `${p.label} · ${f}`),
        ...p.customFields.filter((c) => c.field.trim()).map((c) => `${p.label} · ${c.field}`),
      ])
      return { level: 'modifies', title: '3CX modify', summary: 'Patches the ticked fields on matching items, on every selected PBX.', details: fields.slice(0, 12) }
    }

    default:
      return { level: 'modifies', title: 'Run action', summary: 'Runs the selected action on the chosen systems.', details: [] }
  }
}
