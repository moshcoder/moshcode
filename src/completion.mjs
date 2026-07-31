import {
  CORE_CLI_COMMANDS,
  MCP_VERBS,
  SKILL_VERBS,
  UPGRADE_TARGETS,
} from "./cli-schema.mjs";
import { ENGINES, ENGINE_ALIASES } from "./engines.mjs";
import { TOOLS } from "./tools.mjs";

export const COMPLETION_SHELLS = ["bash", "zsh", "fish"];

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
    upgrade: uniqueEntries([
      ...UPGRADE_TARGETS,
      ...engines,
      ...engineAliases,
      ...tools,
    ]),
    mcp: uniqueEntries(MCP_VERBS),
    mcpServerSpecs: uniqueEntries(MCP_VERBS.filter(({ acceptsServerSpec }) => acceptsServerSpec)),
    skills: uniqueEntries(SKILL_VERBS),
    skillSources: uniqueEntries(SKILL_VERBS.filter(({ acceptsSource }) => acceptsSource)),
    shells: COMPLETION_SHELLS.map((name) => entry(name, `generate ${name} completion`)),
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
      agents|start)
        (( COMP_CWORD == 2 )) && choices="${names(model.engines)}"
        ;;
      install)
        (( COMP_CWORD == 2 )) && choices="${names(model.install)}"
        ;;
      upgrade|update)
        choices="${names(model.upgrade)}"
        ;;
      completion)
        (( COMP_CWORD == 2 )) && choices="${names(model.shells)}"
        ;;
      mcp)
        if (( COMP_CWORD == 2 )); then
          choices="${names(model.mcp)}"
        elif ${shellMatches("nested", model.mcpServerSpecs)} && [[ "$cur" == -* ]]; then
          choices="--name --transport -t --env -e --header -H --"
        fi
        ;;
      skill|skills)
        if (( COMP_CWORD == 2 )); then
          choices="${names(model.skills)}"
        elif ${shellMatches("nested", model.skillSources)} && [[ "$cur" == -* ]]; then
          choices="--name"
        fi
        ;;
      login)
        [[ "$cur" == -* ]] && choices="--browser -b --device -d"
        ;;
      engines|tools|commands)
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
    agents|start)
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
    mcp)
      if (( CURRENT == 3 )); then
        choices=(${zshValues(model.mcp)})
        _describe "mcp command" choices
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
      elif ${shellMatches("{words[3]}", model.skillSources)}; then
        if [[ "$PREFIX" == -* ]]; then _values "skill option" --name; else _files; fi
      fi
      ;;
    login)
      _values "login option" --browser -b --device -d
      ;;
    engines|tools|commands)
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
${fishEntries("__moshcode_command_is upgrade update", model.upgrade)}
${fishEntries(atSecondToken("completion"), model.shells)}
${fishEntries(atSecondToken("mcp"), model.mcp)}
${fishEntries(atSecondToken("skill skills"), model.skills)}
complete -c moshcode -n '__moshcode_command_is login' -l browser -s b -d 'use browser authentication'
complete -c moshcode -n '__moshcode_command_is login' -l device -s d -d 'use device-code authentication'
complete -c moshcode -n '__moshcode_command_is engines tools commands' -l json -d 'print JSON'
complete -c moshcode -n '__moshcode_command_is run' -l dry-run -d 'show actions without executing'
complete -c moshcode -n '__moshcode_command_is run' -l max -s n -r -d 'maximum loop count'
complete -c moshcode -n '${atSecondToken("console")}' -a 'serve' -d 'serve a browser terminal'
complete -c moshcode -n '${atSecondToken("console")}' -a '--url' -d 'print a gateway URL'
complete -c moshcode -n '__moshcode_nested_is console serve' -l port -r -d 'local HTTP port'
complete -c moshcode -n '__moshcode_nested_is console serve' -l ttyd -r -d 'ttyd host and port'
complete -c moshcode -n '__moshcode_nested_is console serve' -l bind -r -d 'bind address'
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
  throw new Error(`unsupported shell ${JSON.stringify(shell)}; choose: ${COMPLETION_SHELLS.join(", ")}`);
}
