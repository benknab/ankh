export const protonPaths = {
  gnupg: "/proton/gnupg",
  passwordStore: "/proton/pass",
  cache: "/proton/cache",
} as const;

export const protonEnvironment = {
  GNUPGHOME: protonPaths.gnupg,
  HOME: "/tmp",
  PASSWORD_STORE_DIR: protonPaths.passwordStore,
  PROTON_DRIVE_CACHE_DIR: protonPaths.cache,
  PROTON_DRIVE_CREDENTIALS_STORE: "pass",
  PROTON_DRIVE_LOG_LEVEL: "WARNING",
};
