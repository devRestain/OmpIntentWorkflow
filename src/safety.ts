export function sensitivePath(path:string):boolean {
  return path.split(/[\\/]/).some(part=>{
    if(/\.(?:example|sample|template|dist)$/i.test(part))return false;
    return /^(?:\.env(?:\..+)?|\.netrc|\.npmrc|\.pypirc|\.aws|\.ssh|\.gnupg|credentials(?:\..+)?|secrets?(?:\..+)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..+)?|service[-_]?account(?:\..+)?|application_default_credentials\.json)$/i.test(part)||/\.(?:pem|key|p12|pfx|keystore)$/i.test(part);
  });
}
export function sensitiveContent(bytes:Uint8Array|string):boolean {
  const text=typeof bytes==='string'?bytes:Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength).toString('utf8');
  return /(?:^|\n)[+ -]?-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/.test(text)||/\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-(?:proj-)?[A-Za-z0-9_-]{32,})\b/.test(text);
}

export function redactForModel(text:string):string {
  return text.replace(/-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----/g,'[REDACTED PRIVATE KEY]')
    .replace(/\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-(?:proj-)?[A-Za-z0-9_-]{32,})\b/g,'[REDACTED CREDENTIAL]');
}
