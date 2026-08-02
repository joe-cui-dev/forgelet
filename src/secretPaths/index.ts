import { basename, normalize, sep } from "node:path";

// Files whose content *is* a credential rather than workspace material. The
// write side has always refused to patch them; the read side refuses to open
// them for the same reason, and both directions consult this one list so a name
// that is secret to one cannot stay ordinary to the other.
//
// The list is deliberately narrower than the write side's older name heuristic
// (`secret`, `token`, `credential`, `key` anywhere in the path). A false
// positive costs a pause the user can approve on the write side, but on the
// read side it makes ordinary source — `keybindings.ts`, `tokenizer.ts` —
// unreadable for the rest of the Session, so the read boundary names actual
// credential files instead of guessing from a substring.
const SECRET_FILE_BASENAMES: ReadonlySet<string> = new Set([
  ".htpasswd",
  ".netrc",
  ".npmrc",
  ".pgpass",
  "_netrc",
  "credentials",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa",
]);

const SECRET_FILE_EXTENSIONS: readonly string[] = [
  ".jks",
  ".key",
  ".keystore",
  ".p12",
  ".pem",
  ".pfx",
];

// Whole trees that only ever hold key material, matched on the directory name
// wherever it appears in the path.
const SECRET_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  ".aws",
  ".gnupg",
  ".ssh",
]);

// `.env.example` and its siblings are the documented way to state which
// variables a workspace needs: they carry names, never values, README points at
// them, and a Session that cannot read one cannot answer "how do I configure
// this". They stay ordinary while every other `.env` variant does not.
const ENV_TEMPLATE_SUFFIXES: readonly string[] = [
  ".dist",
  ".example",
  ".sample",
  ".template",
];

export const isSecretBearingPath = (workspacePath: string): boolean => {
  const normalized = normalize(workspacePath);
  if (normalized.split(sep).some((segment) => SECRET_DIRECTORY_NAMES.has(segment)))
    return true;
  const name = basename(normalized).toLowerCase();
  if (SECRET_FILE_BASENAMES.has(name)) return true;
  if (SECRET_FILE_EXTENSIONS.some((extension) => name.endsWith(extension)))
    return true;
  return isEnvFileName(name);
};

const isEnvFileName = (name: string): boolean => {
  const looksLikeEnvFile =
    name === ".env" || name.startsWith(".env.") || name.endsWith(".env");
  if (!looksLikeEnvFile) return false;
  return !ENV_TEMPLATE_SUFFIXES.some((suffix) => name.endsWith(suffix));
};
