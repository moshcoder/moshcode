import {
  CORE_CLI_COMMANDS,
  MCP_VERBS,
  SKILL_VERBS,
  TRADE_VERBS,
  UPGRADE_TARGETS,
} from "./cli-schema.mjs";
import { ENGINES, ENGINE_ALIASES } from "./engines.mjs";
import { TOOLS } from "./tools.mjs";
import { moshVocabulary } from "./commands.mjs";

export const COMPLETION_SHELLS = ["bash", "zsh", "fish", "powershell"];

function entry(name, description) {
  const value = String(name);
  if (!/^-{0,2}[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) {
    throw new Error(`completion name is not shell-safe: ${JSON.stringify(value)}`);
  }
  return { name: value, description: String(description).replace(/\s+/g, " ").trim() };
}

function uniqueEntries(entries) {
  const found = new Map();
  for (const item of entries) {
    const normalized = entry(item.name, item.description);
    if (!found.has(normalized.name)) found.set(normalized.name, normalized);
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function completionModel() {
  const engines = Object.entries(ENGINES).map(([name, engine]) => entry(name, engine.desc));
  const engineAliases = Object.entries(ENGINE_ALIASES).map(([name, target]) => (
    entry(name, `alias for ${target}`)
  ));
  const tools = Object.entries(TOOLS).map(([name, tool]) => entry(name, tool.desc));
  const install = uniqueEntries([...engines, ...tools]);

  return {
    top: uniqueEntries([...CORE_CLI_COMMANDS, ...engines, ...engineAliases, ...tools]),
    engines: uniqueEntries([...engines, ...engineAliases]),
    install,
    // `uninstall <engine|tool>` resolves its target against the same ENGINES and
    // TOOLS rosters `install` does, so it offers the same targets. Kept as its
    // own key rather than reusing `install` so the two can diverge without a
    // silent surprise in one of them.
    uninstall: install,
    upgrade: uniqueEntries([
      ...UPGRADE_TARGETS,
      ...engines,
      ...engineAliases,
      ...tools,
    ]),
    mcp: uniqueEntries(MCP_VERBS),
    mcpServerSpecs: uniqueEntries(MCP_VERBS.filter(({ acceptsServerSpec }) => acceptsServerSpec)),
    skills: uniqueEntries(SKILL_VERBS),
    trade: uniqueEntries(TRADE_VERBS),
    tradeOrderOptions: uniqueEntries([
      entry("--submit", "place the order instead of previewing"),
      entry("--qty", "share quantity"),
      entry("--notional", "dollar amount"),
      entry("--type", "market, limit, stop, stop_limit, or trailing_stop"),
      entry("--limit-price", "limit price"),
      entry("--stop-price", "stop price"),
      entry("--time-in-force", "order time in force"),
    ]),
    skillSources: uniqueEntries(SKILL_VERBS.filter(({ acceptsSource }) => acceptsSource)),
    shells: COMPLETION_SHELLS.map((name) => entry(name, `generate ${name} completion`)),
    // `moshcode help <topic>` accepts anything help can answer for: a command,
    // an engine, a tool, or a moshscript verb (PRD 0006 R16). Offering the same
    // set here is what keeps tab-completion and help one discoverability
    // surface rather than two that disagree.
    helpTopics: uniqueEntries([
      ...CORE_CLI_COMMANDS.filter(({ name }) => !name.startsWith("-")),
      ...engines,
      ...tools,
      ...moshVocabulary().all().map((c) => entry(c.name, c.summary || "moshscript verb")),
    ]),
  };
}

function names(entries) {
  return entries.map(({ name }) => name).join(" ");
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function zshValues(entries) {
  return entries.map(({ name, description }) => shellQuote(`${name}:${description}`)).join(" ");
}

function shellMatches(variable, entries) {
  return `[[ ${entries.map(({ name }) => `"$${variable}" == "${name}"`).join(" || ")} ]]`;
}

function fishQuote(value) {
  return `'${String(value).replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

function fishEntries(condition, entries) {
  return entries.map(({ name, description }) => (
    `complete -c moshcode -n ${fishQuote(condition)} -a ${fishQuote(name)} -d ${fishQuote(description)}`
  )).join("\n");
}

function powershellQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function powershellEntries(variable, entries) {
  const rows = entries.map(({ name, description }) => (
    `  [pscustomobject]@{ Name = ${powershellQuote(name)}; Description = ${powershellQuote(description)} }`
  ));
  return `$script:${variable} = @(\n${rows.join("\n")}\n)`;
}

function powershellCompletion(model) {
  const optionEntries = (values, description = "option") => (
    values.split(" ").filter(Boolean).map((name) => entry(name, description))
  );

  return `# PowerShell completion for moshcode
${powershellEntries("MoshcodeCompletionTop", model.top)}
${powershellEntries("MoshcodeCompletionEngines", model.engines)}
${powershellEntries("MoshcodeCompletionInstall", model.install)}
${powershellEntries("MoshcodeCompletionUninstall", model.uninstall)}
${powershellEntries("MoshcodeCompletionUpgrade", model.upgrade)}
${powershellEntries("MoshcodeCompletionMcp", model.mcp)}
${powershellEntries("MoshcodeCompletionMcpServerSpecs", model.mcpServerSpecs)}
${powershellEntries("MoshcodeCompletionSkills", model.skills)}
${powershellEntries("MoshcodeCompletionTrade", model.trade)}
${powershellEntries("MoshcodeCompletionTradeOrderOptions", model.tradeOrderOptions)}
${powershellEntries("MoshcodeCompletionSkillSources", model.skillSources)}
${powershellEntries("MoshcodeCompletionShells", model.shells)}
${powershellEntries("MoshcodeCompletionHelpTopics", model.helpTopics)}
${powershellEntries("MoshcodeCompletionJson", optionEntries("--json", "print JSON"))}
${powershellEntries("MoshcodeCompletionLogin", optionEntries("--browser -b --device -d", "authentication mode"))}
${powershellEntries("MoshcodeCompletionRun", optionEntries("--dry-run --max -n", "run option"))}
${powershellEntries("MoshcodeCompletionUninstallOptions", optionEntries("--yes -y --dry-run", "uninstall option"))}
${powershellEntries("MoshcodeCompletionConsole", optionEntries("serve --url", "console command"))}
${powershellEntries("MoshcodeCompletionConsoleServe", optionEntries("--port --ttyd --bind", "console serve option"))}
${powershellEntries("MoshcodeCompletionTemplate", optionEntries("list install", "template command"))}
${powershellEntries("MoshcodeCompletionTemplateInstall", optionEntries("--into --force --dry-run", "template install option"))}
${powershellEntries("MoshcodeCompletionMcpOptions", optionEntries("--name --transport -t --env -e --header -H", "MCP option"))}
${powershellEntries("MoshcodeCompletionSkillOptions", optionEntries("--name", "skill option"))}

Register-ArgumentCompleter -Native -CommandName moshcode -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)

  $tokens = @($commandAst.CommandElements | ForEach-Object { $_.Extent.Text })
  $argumentIndex = if ([string]::IsNullOrEmpty($wordToComplete)) {
    $tokens.Count
  } else {
    $tokens.Count - 1
  }
  $command = if ($tokens.Count -gt 1) { $tokens[1] } else { '' }
  $nested = if ($tokens.Count -gt 2) { $tokens[2] } else { '' }
  $choices = @()

  if ($argumentIndex -eq 1) {
    $choices = $script:MoshcodeCompletionTop
  } else {
    switch ($command) {
      { $_ -in @('agents', 'start') } {
        if ($argumentIndex -eq 2) {
          $choices = if ($command -eq 'agents' -and $wordToComplete.StartsWith('-')) {
            $script:MoshcodeCompletionJson
          } else { $script:MoshcodeCompletionEngines }
        }
      }
      'install' {
        if ($argumentIndex -eq 2) { $choices = $script:MoshcodeCompletionInstall }
      }
      { $_ -in @('uninstall', 'remove') } {
        if ($argumentIndex -eq 2 -and -not $wordToComplete.StartsWith('-')) {
          $choices = $script:MoshcodeCompletionUninstall
        } elseif ($wordToComplete.StartsWith('-')) {
          $choices = $script:MoshcodeCompletionUninstallOptions
        }
      }
      { $_ -in @('upgrade', 'update') } {
        $choices = $script:MoshcodeCompletionUpgrade
      }
      'help' {
        if ($argumentIndex -eq 2) { $choices = $script:MoshcodeCompletionHelpTopics }
      }
      'completion' {
        if ($argumentIndex -eq 2) { $choices = $script:MoshcodeCompletionShells }
      }
      'mcp' {
        if ($argumentIndex -eq 2) {
          $choices = $script:MoshcodeCompletionMcp
        } elseif ($nested -eq 'list' -and $wordToComplete.StartsWith('-')) {
          $choices = $script:MoshcodeCompletionJson
        } elseif ($script:MoshcodeCompletionMcpServerSpecs.Name -contains $nested -and $wordToComplete.StartsWith('-')) {
          $choices = $script:MoshcodeCompletionMcpOptions
        }
      }
      { $_ -in @('skill', 'skills') } {
        if ($argumentIndex -eq 2) {
          $choices = $script:MoshcodeCompletionSkills
        } elseif ($nested -eq 'list' -and $wordToComplete.StartsWith('-')) {
          $choices = $script:MoshcodeCompletionJson
        } elseif ($script:MoshcodeCompletionSkillSources.Name -contains $nested -and $wordToComplete.StartsWith('-')) {
          $choices = $script:MoshcodeCompletionSkillOptions
        }
      }
      'trade' {
        if ($argumentIndex -eq 2) {
          $choices = $script:MoshcodeCompletionTrade
        } elseif ($nested -in @('buy', 'sell') -and $wordToComplete.StartsWith('-')) {
          $choices = $script:MoshcodeCompletionTradeOrderOptions
        }
      }
      'login' { if ($wordToComplete.StartsWith('-')) { $choices = $script:MoshcodeCompletionLogin } }
      { $_ -in @('whoami', 'engines', 'tools', 'commands') } {
        if ($wordToComplete.StartsWith('-')) { $choices = $script:MoshcodeCompletionJson }
      }
      'run' { if ($wordToComplete.StartsWith('-')) { $choices = $script:MoshcodeCompletionRun } }
      'console' {
        if ($argumentIndex -eq 2) {
          $choices = $script:MoshcodeCompletionConsole
        } elseif ($nested -eq 'serve' -and $wordToComplete.StartsWith('-')) {
          $choices = $script:MoshcodeCompletionConsoleServe
        }
      }
      { $_ -in @('template', 'templates') } {
        if ($argumentIndex -eq 2) {
          $choices = $script:MoshcodeCompletionTemplate
        } elseif ($nested -eq 'list' -and $wordToComplete.StartsWith('-')) {
          $choices = $script:MoshcodeCompletionJson
        } elseif ($nested -eq 'install' -and $wordToComplete.StartsWith('-')) {
          $choices = $script:MoshcodeCompletionTemplateInstall
        }
      }
    }
  }

  foreach ($candidate in $choices) {
    if ($candidate.Name.StartsWith($wordToComplete, [System.StringComparison]::OrdinalIgnoreCase)) {
      [System.Management.Automation.CompletionResult]::new(
        $candidate.Name,
        $candidate.Name,
        [System.Management.Automation.CompletionResultType]::ParameterValue,
        $candidate.Description
      )
    }
  }
}
`;
}

function bashCompletion(model) {
  return `# bash completion for moshcode
_moshcode_completion() {
  local cur subcommand nested choices
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]-}"
  subcommand="\${COMP_WORDS[1]-}"
  nested="\${COMP_WORDS[2]-}"
  choices=""

  if (( COMP_CWORD == 1 )); then
    choices="${names(model.top)}"
  else
    case "$subcommand" in
      agents)
        if (( COMP_CWORD == 2 )); then
          if [[ "$cur" == -* ]]; then choices="--json"; else choices="${names(model.engines)}"; fi
        fi
        ;;
      start)
        (( COMP_CWORD == 2 )) && choices="${names(model.engines)}"
        ;;
      install)
        (( COMP_CWORD == 2 )) && choices="${names(model.install)}"
        ;;
      uninstall|remove)
        if (( COMP_CWORD == 2 )); then
          choices="${names(model.uninstall)}"
        elif [[ "$cur" == -* ]]; then
          choices="--yes -y --dry-run"
        fi
        ;;
      upgrade|update)
        choices="${names(model.upgrade)}"
        ;;
      completion)
        (( COMP_CWORD == 2 )) && choices="${names(model.shells)}"
        ;;
      help)
        (( COMP_CWORD == 2 )) && choices="${names(model.helpTopics)}"
        ;;
      mcp)
        if (( COMP_CWORD == 2 )); then
          choices="${names(model.mcp)}"
        elif [[ "$nested" == "list" && "$cur" == -* ]]; then
          choices="--json"
        elif ${shellMatches("nested", model.mcpServerSpecs)} && [[ "$cur" == -* ]]; then
          choices="--name --transport -t --env -e --header -H --"
        fi
        ;;
      skill|skills)
        if (( COMP_CWORD == 2 )); then
          choices="${names(model.skills)}"
        elif [[ "$nested" == "list" && "$cur" == -* ]]; then
          choices="--json"
        elif ${shellMatches("nested", model.skillSources)} && [[ "$cur" == -* ]]; then
          choices="--name"
        fi
        ;;
      trade)
        if (( COMP_CWORD == 2 )); then
          choices="${names(model.trade)}"
        elif [[ "$nested" == "buy" || "$nested" == "sell" ]] && [[ "$cur" == -* ]]; then
          choices="${names(model.tradeOrderOptions)}"
        fi
        ;;
      login)
        [[ "$cur" == -* ]] && choices="--browser -b --device -d"
        ;;
      whoami|engines|tools|commands)
        [[ "$cur" == -* ]] && choices="--json"
        ;;
      run)
        [[ "$cur" == -* ]] && choices="--dry-run --max -n"
        ;;
      console)
        if (( COMP_CWORD == 2 )); then
          choices="serve --url"
        elif [[ "$nested" == "serve" && "$cur" == -* ]]; then
          choices="--port --ttyd --bind"
        fi
        ;;
      dns)
        if (( COMP_CWORD == 2 )); then
          choices="enable disable status tlds resolve start install trust filter"
        elif [[ "$nested" == "resolve" && "$cur" == -* ]]; then
          choices="--json --open --registry"
        fi
        ;;
      template|templates)
        if (( COMP_CWORD == 2 )); then
          choices="list install"
        elif [[ "$nested" == "list" && "$cur" == -* ]]; then
          choices="--json"
        elif [[ "$nested" == "install" && "$cur" == -* ]]; then
          choices="--into --force --dry-run"
        fi
        ;;
    esac
  fi

  if [[ -n "$choices" ]]; then
    COMPREPLY=( $(compgen -W "$choices" -- "$cur") )
  fi
}
complete -o bashdefault -o default -F _moshcode_completion moshcode
`;
}

function zshCompletion(model) {
  return `#compdef moshcode
# zsh completion for moshcode
_moshcode() {
  local -a choices

  if (( CURRENT == 2 )); then
    choices=(${zshValues(model.top)})
    _describe "moshcode command" choices
    return
  fi

  case "\${words[2]}" in
    agents)
      if (( CURRENT == 3 )); then
        if [[ "$PREFIX" == -* ]]; then
          _values "agent option" --json
        else
          choices=(${zshValues(model.engines)})
          _describe "engine" choices
        fi
      else
        _files
      fi
      ;;
    start)
      if (( CURRENT == 3 )); then
        choices=(${zshValues(model.engines)})
        _describe "engine" choices
      else
        _files
      fi
      ;;
    install)
      if (( CURRENT == 3 )); then
        choices=(${zshValues(model.install)})
        _describe "install target" choices
      else
        _files
      fi
      ;;
    uninstall|remove)
      if (( CURRENT == 3 )); then
        choices=(${zshValues(model.uninstall)})
        _describe "uninstall target" choices
      else
        _values "uninstall option" --yes -y --dry-run
      fi
      ;;
    upgrade|update)
      choices=(${zshValues(model.upgrade)})
      _describe "upgrade target" choices
      ;;
    completion)
      if (( CURRENT == 3 )); then
        choices=(${zshValues(model.shells)})
        _describe "shell" choices
      fi
      ;;
    help)
      if (( CURRENT == 3 )); then
        choices=(${zshValues(model.helpTopics)})
        _describe "help topic" choices
      fi
      ;;
    mcp)
      if (( CURRENT == 3 )); then
        choices=(${zshValues(model.mcp)})
        _describe "mcp command" choices
      elif [[ "\${words[3]}" == "list" && "$PREFIX" == -* ]]; then
        _values "mcp list option" --json
      elif ${shellMatches("{words[3]}", model.mcpServerSpecs)}; then
        if [[ "$PREFIX" == -* ]]; then
          _values "mcp option" --name --transport -t --env -e --header -H --
        else
          _files
        fi
      fi
      ;;
    skill|skills)
      if (( CURRENT == 3 )); then
        choices=(${zshValues(model.skills)})
        _describe "skill command" choices
      elif [[ "\${words[3]}" == "list" && "$PREFIX" == -* ]]; then
        _values "skill list option" --json
      elif ${shellMatches("{words[3]}", model.skillSources)}; then
        if [[ "$PREFIX" == -* ]]; then _values "skill option" --name; else _files; fi
      fi
      ;;
    trade)
      if (( CURRENT == 3 )); then
        choices=(${zshValues(model.trade)})
        _describe "trade command" choices
      elif [[ "\${words[3]}" == "buy" || "\${words[3]}" == "sell" ]] && [[ "$PREFIX" == -* ]]; then
        choices=(${zshValues(model.tradeOrderOptions)})
        _describe "trade order option" choices
      else
        _files
      fi
      ;;
    login)
      _values "login option" --browser -b --device -d
      ;;
    whoami|engines|tools|commands)
      _values "option" --json
      ;;
    run)
      if [[ "$PREFIX" == -* ]]; then
        _values "run option" --dry-run --max -n
      else
        _files
      fi
      ;;
    console)
      if (( CURRENT == 3 )); then
        _values "console command" serve --url
      elif [[ "\${words[3]}" == "serve" && "$PREFIX" == -* ]]; then
        _values "console option" --port --ttyd --bind
      else
        _files
      fi
      ;;
    dns)
      if (( CURRENT == 3 )); then
        _values "dns command" enable disable status tlds resolve start install trust filter
      elif [[ "\${words[3]}" == "resolve" && "$PREFIX" == -* ]]; then
        _values "dns resolve option" --json --open --registry
      else
        _files
      fi
      ;;
    template|templates)
      if (( CURRENT == 3 )); then
        _values "template command" list install
      elif [[ "\${words[3]}" == "list" && "$PREFIX" == -* ]]; then
        _values "template list option" --json
      elif [[ "\${words[3]}" == "install" && "$PREFIX" == -* ]]; then
        _values "template install option" --into --force --dry-run
      else
        _files
      fi
      ;;
    *)
      _files
      ;;
  esac
}

if (( ! $+functions[compdef] )); then
  autoload -Uz compinit
  compinit
fi
compdef _moshcode moshcode
`;
}

function fishCompletion(model) {
  const atFirstArgument = "__fish_use_subcommand";
  const atSecondToken = (commands) => (
    `__moshcode_command_is ${commands}; and __moshcode_arg_index 2`
  );
  const nestedCondition = (command, entries) => (
    entries.map(({ name }) => `__moshcode_nested_is ${command} ${name}`).join("; or ")
  );

  return `# fish completion for moshcode
function __moshcode_command_is
  set -l tokens (commandline -opc)
  test (count $tokens) -ge 2; and contains -- $tokens[2] $argv
end

function __moshcode_nested_is
  set -l tokens (commandline -opc)
  test (count $tokens) -ge 3; and test "$tokens[2]" = "$argv[1]"; and test "$tokens[3]" = "$argv[2]"
end

function __moshcode_arg_index
  test (count (commandline -opc)) -eq $argv[1]
end

${fishEntries(atFirstArgument, model.top)}
${fishEntries(atSecondToken("agents start"), model.engines)}
${fishEntries(atSecondToken("install"), model.install)}
${fishEntries(atSecondToken("uninstall remove"), model.uninstall)}
${fishEntries("__moshcode_command_is upgrade update", model.upgrade)}
${fishEntries(atSecondToken("completion"), model.shells)}
${fishEntries(atSecondToken("help"), model.helpTopics)}
${fishEntries(atSecondToken("mcp"), model.mcp)}
${fishEntries(atSecondToken("skill skills"), model.skills)}
${fishEntries(atSecondToken("trade"), model.trade)}
${fishEntries("__moshcode_nested_is trade buy; or __moshcode_nested_is trade sell", model.tradeOrderOptions)}
complete -c moshcode -n '__moshcode_nested_is mcp list' -l json -d 'print JSON'
complete -c moshcode -n '__moshcode_nested_is skill list; or __moshcode_nested_is skills list' -l json -d 'print JSON'
complete -c moshcode -n '__moshcode_command_is login' -l browser -s b -d 'use browser authentication'
complete -c moshcode -n '__moshcode_command_is login' -l device -s d -d 'use device-code authentication'
complete -c moshcode -n '${atSecondToken("agents whoami engines tools commands")}' -l json -d 'print JSON'
complete -c moshcode -n '__moshcode_command_is run' -l dry-run -d 'show actions without executing'
complete -c moshcode -n '__moshcode_command_is run' -l max -s n -r -d 'maximum loop count'
complete -c moshcode -n '__moshcode_command_is uninstall remove' -l yes -s y -d 'confirm deleting a binary'
complete -c moshcode -n '__moshcode_command_is uninstall remove' -l dry-run -d 'show the plan without removing'
complete -c moshcode -n '${atSecondToken("console")}' -a 'serve' -d 'serve a browser terminal'
complete -c moshcode -n '${atSecondToken("console")}' -a '--url' -d 'print a gateway URL'
complete -c moshcode -n '__moshcode_nested_is console serve' -l port -r -d 'local HTTP port'
complete -c moshcode -n '__moshcode_nested_is console serve' -l ttyd -r -d 'ttyd host and port'
complete -c moshcode -n '__moshcode_nested_is console serve' -l bind -r -d 'bind address'
complete -c moshcode -n '${atSecondToken("dns")}' -a 'enable disable status tlds resolve start install trust filter' -d 'dns command'
complete -c moshcode -n '__moshcode_nested_is dns resolve' -l json -d 'print JSON'
complete -c moshcode -n '__moshcode_nested_is dns resolve' -l open -d 'open a parked name in the Pit'
complete -c moshcode -n '__moshcode_nested_is dns resolve' -l registry -r -d 'registry base URL'
complete -c moshcode -n '${atSecondToken("template templates")}' -a 'list install' -d 'template command'
complete -c moshcode -n '__moshcode_nested_is template list; or __moshcode_nested_is templates list' -l json -d 'print JSON'
complete -c moshcode -n '__moshcode_nested_is template install; or __moshcode_nested_is templates install' -l into -r -d 'target directory'
complete -c moshcode -n '__moshcode_nested_is template install; or __moshcode_nested_is templates install' -l force -d 'overwrite existing files'
complete -c moshcode -n '__moshcode_nested_is template install; or __moshcode_nested_is templates install' -l dry-run -d 'preview without writing'
complete -c moshcode -n '${nestedCondition("mcp", model.mcpServerSpecs)}' -l name -r -d 'server name'
complete -c moshcode -n '${nestedCondition("mcp", model.mcpServerSpecs)}' -l transport -s t -r -d 'MCP transport'
complete -c moshcode -n '${nestedCondition("mcp", model.mcpServerSpecs)}' -l env -s e -r -d 'environment KEY=VALUE'
complete -c moshcode -n '${nestedCondition("mcp", model.mcpServerSpecs)}' -l header -s H -r -d 'HTTP Name: Value header'
complete -c moshcode -n '${nestedCondition("skill", model.skillSources)}; or ${nestedCondition("skills", model.skillSources)}' -l name -r -d 'installed skill name'
`;
}

export function completionScript(shell) {
  const normalized = String(shell || "").trim().toLowerCase();
  const model = completionModel();
  if (normalized === "bash") return bashCompletion(model);
  if (normalized === "zsh") return zshCompletion(model);
  if (normalized === "fish") return fishCompletion(model);
  if (normalized === "powershell" || normalized === "pwsh") return powershellCompletion(model);
  throw new Error(`unsupported shell ${JSON.stringify(shell)}; choose: ${COMPLETION_SHELLS.join(", ")}`);
}
