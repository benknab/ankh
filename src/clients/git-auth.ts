import { Option, Schema } from "effect";
import type { GitRepository } from "#clients/git.ts";
import type { Options } from "#process/commands.ts";

export const gitOptions = (repository: GitRepository): Options => {
  const url = Schema.decodeOption(Schema.URLFromString)(repository.url).pipe(
    Option.filter((value) => value.protocol === "http:" || value.protocol === "https:"),
  );
  const origin = Option.match(url, { onNone: () => "", onSome: (value) => value.origin });
  return {
    output: "tail",
    env: {
      GIT_ASKPASS: "/app/gitea-askpass.sh",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
      GITEA_TOKEN_FILE: repository.tokenFile,
      GITEA_ORIGIN: origin,
      GIT_CONFIG_COUNT: origin === "" ? "3" : "5",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: "credential.useHttpPath",
      GIT_CONFIG_VALUE_1: "false",
      GIT_CONFIG_KEY_2: "http.followRedirects",
      GIT_CONFIG_VALUE_2: "false",
      ...(origin === ""
        ? {}
        : {
            GIT_CONFIG_KEY_3: "lfs.url",
            GIT_CONFIG_VALUE_3: `${repository.url}/info/lfs`,
            GIT_CONFIG_KEY_4: "remote.origin.lfsurl",
            GIT_CONFIG_VALUE_4: `${repository.url}/info/lfs`,
          }),
    },
  };
};
