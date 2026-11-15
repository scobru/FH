//! Public directory of Freenet apps. One shared instance; parameters = root admin ed25519 pubkey (32 bytes) || app path
//! (`/v1/contract/web/<FH id>/`). Only the root admin or delegated admins (listed in `admins`, signed by the root admin)
//! may add, edit, or delete entries. Each entry is kept per site key, newest wins, so every merge order converges.
//! The root admin hides sites with a signed blocklist. The newest MAX_ENTRIES entries are kept. State is JSON.
use freenet_stdlib::prelude::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use whoiam_delegation::{check, key, verify, Cert, R};

pub const POW_BITS: u32 = 12;
pub const MAX_ENTRIES: usize = 1000;
const MAX_NAME: usize = 60;
const MAX_DESC: usize = 200;
const MAX_ADMINS: usize = 256;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Entry {
    pub by: String, // lowercase 64-char hex pubkey of the admin persona
    pub name: String,
    pub desc: String,
    pub ts: u64,
    pub nonce: u64,
    pub sig: String, // hex, by `by`'s delegated app key over `fhd1|<site>|<by>|<name>|<desc>|<ts>`
    pub cert: Cert,  // `by`'s delegation to that key
    #[serde(default)]
    pub deleted: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Blocklist {
    pub ts: u64,
    pub list: Vec<String>, // site keys
    pub sig: String,       // hex, by root admin over `fhb1|<ts>|<list joined by ,>`
    #[serde(default)]
    pub cert: Option<Cert>, // delegation from the root admin persona for this app path
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Admins {
    pub ts: u64,
    pub list: Vec<String>, // lowercase 64-char hex pubkeys of delegated admins
    pub sig: String,       // hex, by root admin over `fha1|<ts>|<list joined by ,>`
    #[serde(default)]
    pub cert: Option<Cert>, // delegation from the root admin persona for this app path
}

/// Also the delta: an update carries the entries, blocklist, and admins list to merge.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct DirState {
    #[serde(default)]
    pub entries: BTreeMap<String, Entry>, // site key (base58) -> latest entry
    #[serde(default)]
    pub blocked: Blocklist,
    #[serde(default)]
    pub admins: Admins,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Summary {
    pub entries: BTreeMap<String, u64>,
    pub blocked_ts: u64,
    #[serde(default)]
    pub admins_ts: u64,
}

pub fn entry_msg(site: &str, persona: &str, e: &Entry) -> String {
    if e.deleted {
        format!("fhd1|{site}|{persona}|[deleted]|{}", e.ts)
    } else {
        format!("fhd1|{site}|{persona}|{}|{}|{}", e.name, e.desc, e.ts)
    }
}

fn zero_bits(h: &[u8]) -> u32 {
    let mut n = 0;
    for b in h {
        n += b.leading_zeros();
        if *b != 0 {
            break;
        }
    }
    n
}

fn is_site(s: &str) -> bool {
    (32..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric())
}

fn is_hex_pubkey(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn is_admin(root: &str, admins: &Admins, persona: &str) -> bool {
    persona == root || admins.list.iter().any(|a| a == persona)
}

fn text_ok(s: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&s.chars().count()) && !s.chars().any(char::is_control) && !s.contains('|')
}

fn verify_root_signed(admin: &str, app: &str, msg: &str, sig: &str, cert: &Option<Cert>) -> R<()> {
    if let Some(cert) = cert {
        let app_key = check(admin, app, cert)?;
        verify(&app_key, msg.as_bytes(), sig)
    } else {
        verify(&key(admin)?, msg.as_bytes(), sig)
    }
}

fn check_entry(root: &str, app: &str, admins: &Admins, site: &str, e: &Entry) -> R<()> {
    if !is_site(site) || !is_hex_pubkey(&e.by) {
        return Err("bad entry".into());
    }
    if !is_admin(root, admins, &e.by) {
        return Err("not an admin".into());
    }
    if !e.deleted && (!text_ok(&e.name, 1, MAX_NAME) || !text_ok(&e.desc, 0, MAX_DESC)) {
        return Err("bad entry".into());
    }
    let msg = entry_msg(site, &e.by, e);
    verify(&check(&e.by, app, &e.cert)?, msg.as_bytes(), &e.sig)?;
    if zero_bits(&Sha256::digest(format!("{msg}|{}", e.nonce).as_bytes())) < POW_BITS {
        return Err("insufficient proof of work".into());
    }
    Ok(())
}

fn check_blocklist(admin: &str, app: &str, b: &Blocklist) -> R<()> {
    if *b == Blocklist::default() {
        return Ok(()); // initial empty state
    }
    if b.list.len() > 10_000 || !b.list.iter().all(|s| is_site(s)) {
        return Err("bad blocklist".into());
    }
    let msg = format!("fhb1|{}|{}", b.ts, b.list.join(","));
    verify_root_signed(admin, app, &msg, &b.sig, &b.cert)
}

fn check_admins(admin: &str, app: &str, a: &Admins) -> R<()> {
    if *a == Admins::default() {
        return Ok(());
    }
    if a.list.len() > MAX_ADMINS || !a.list.iter().all(|p| is_hex_pubkey(p)) {
        return Err("bad admins list".into());
    }
    let msg = format!("fha1|{}|{}", a.ts, a.list.join(","));
    verify_root_signed(admin, app, &msg, &a.sig, &a.cert)
}

fn split(params: &str) -> R<(String, String)> {
    let raw = hex::decode(params).map_err(|e| e.to_string())?;
    let app = std::str::from_utf8(raw.get(32..).ok_or("params too short")?).map_err(|e| e.to_string())?;
    Ok((params[..64].to_string(), app.to_string()))
}

/// Keep the newest `max` entries; deterministic, so merge order does not matter.
fn prune(s: &mut DirState, max: usize) {
    if s.entries.len() <= max {
        return;
    }
    let mut all: Vec<_> = s.entries.iter().map(|(site, e)| (std::cmp::Reverse(e.ts), site.clone())).collect();
    all.sort();
    for (_, site) in all.into_iter().skip(max) {
        s.entries.remove(&site);
    }
}

pub fn validate(params: &str, s: &DirState) -> R<()> {
    let (admin, app) = split(params)?;
    check_admins(&admin, &app, &s.admins)?;
    check_blocklist(&admin, &app, &s.blocked)?;
    if s.entries.len() > MAX_ENTRIES || s.entries.keys().any(|k| s.blocked.list.contains(k)) {
        return Err("state out of bounds".into());
    }
    s.entries.iter().try_for_each(|(site, e)| check_entry(&admin, &app, &s.admins, site, e))
}

/// Merge `d` into `s`. Invalid parts of `d` are an error, so a bad update is refused as a whole.
pub fn apply(params: &str, s: &mut DirState, d: DirState) -> R<()> {
    let (admin, app) = split(params)?;
    if (d.admins.ts, &d.admins.sig) > (s.admins.ts, &s.admins.sig) {
        check_admins(&admin, &app, &d.admins)?;
        s.admins = d.admins;
    }
    if (d.blocked.ts, &d.blocked.sig) > (s.blocked.ts, &s.blocked.sig) {
        check_blocklist(&admin, &app, &d.blocked)?;
        s.blocked = d.blocked;
    }
    for (site, e) in d.entries {
        check_entry(&admin, &app, &s.admins, &site, &e)?;
        if s.entries.get(&site).is_none_or(|old| (e.ts, &e.sig) > (old.ts, &old.sig)) {
            s.entries.insert(site, e);
        }
    }
    let blocked = s.blocked.list.clone();
    let admins = s.admins.clone();
    s.entries.retain(|site, e| !blocked.contains(site) && is_admin(&admin, &admins, &e.by));
    prune(s, MAX_ENTRIES);
    Ok(())
}

pub fn summarize(s: &DirState) -> Summary {
    Summary {
        entries: s.entries.iter().map(|(site, e)| (site.clone(), e.ts)).collect(),
        blocked_ts: s.blocked.ts,
        admins_ts: s.admins.ts,
    }
}

pub fn delta(s: &DirState, known: &Summary) -> DirState {
    let newer = |site: &str, e: &Entry| known.entries.get(site).is_none_or(|ts| e.ts > *ts);
    DirState {
        entries: s.entries.iter()
            .filter(|(site, e)| newer(site, e))
            .map(|(site, e)| (site.clone(), e.clone()))
            .collect(),
        blocked: if s.blocked.ts > known.blocked_ts { s.blocked.clone() } else { Blocklist::default() },
        admins: if s.admins.ts > known.admins_ts { s.admins.clone() } else { Admins::default() },
    }
}

// ---- Freenet glue ----

fn de<T: for<'a> Deserialize<'a> + Default>(b: &[u8]) -> Result<T, ContractError> {
    if b.is_empty() { return Ok(T::default()); } // e.g. subscribe with no summary: nothing known yet
    serde_json::from_slice(b).map_err(|e| ContractError::Deser(e.to_string()))
}

fn ser<T: Serialize>(v: &T) -> Result<Vec<u8>, ContractError> {
    serde_json::to_vec(v).map_err(|e| ContractError::Deser(e.to_string()))
}

struct Contract;

#[contract]
impl ContractInterface for Contract {
    fn validate_state(
        parameters: Parameters<'static>,
        state: State<'static>,
        _related: RelatedContracts<'static>,
    ) -> Result<ValidateResult, ContractError> {
        Ok(match validate(&hex::encode(parameters.as_ref()), &de(state.as_ref())?) {
            Ok(()) => ValidateResult::Valid,
            Err(_) => ValidateResult::Invalid,
        })
    }

    fn update_state(
        parameters: Parameters<'static>,
        state: State<'static>,
        data: Vec<UpdateData<'static>>,
    ) -> Result<UpdateModification<'static>, ContractError> {
        let params = hex::encode(parameters.as_ref());
        let mut s: DirState = de(state.as_ref())?;
        for u in data {
            let d: DirState = match u {
                UpdateData::State(st) => de(st.as_ref())?,
                UpdateData::Delta(d) => de(d.as_ref())?,
                UpdateData::StateAndDelta { delta, .. } => de(delta.as_ref())?,
                _ => return Err(ContractError::InvalidUpdate),
            };
            apply(&params, &mut s, d).map_err(|_| ContractError::InvalidUpdate)?;
        }
        Ok(UpdateModification::valid(State::from(ser(&s)?)))
    }

    fn summarize_state(
        _parameters: Parameters<'static>,
        state: State<'static>,
    ) -> Result<StateSummary<'static>, ContractError> {
        Ok(StateSummary::from(ser(&summarize(&de(state.as_ref())?))?))
    }

    fn get_state_delta(
        _parameters: Parameters<'static>,
        state: State<'static>,
        summary: StateSummary<'static>,
    ) -> Result<StateDelta<'static>, ContractError> {
        Ok(StateDelta::from(ser(&delta(&de(state.as_ref())?, &de(summary.as_ref())?))?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use whoiam_delegation::connect_message;

    const APP: &str = "/v1/contract/web/FH1/";
    const SITE: &str = "4dg9mbpxeuMbQhh6Kr2ZjeHFtijMJAK5RoMbxT6rTyMP";
    fn sk(n: u8) -> SigningKey { SigningKey::from_bytes(&[n; 32]) }
    fn pk(k: &SigningKey) -> String { hex::encode(k.verifying_key().as_bytes()) }
    fn params() -> String { format!("{}{}", pk(&sk(99)), hex::encode(APP)) }

    fn cert_for(who: &SigningKey, app: &str, app_key: &SigningKey) -> Cert {
        let base = format!("http://127.0.0.1:7509{app}");
        let challenge = format!("wd1.{}.n1", pk(app_key));
        let csig = who.sign(&connect_message(who.verifying_key().as_bytes(), &base, &challenge, 1));
        Cert { base, challenge, ts: 1, sig: hex::encode(csig.to_bytes()) }
    }

    /// `who`'s entry for `site`, signed by an app key delegated for `app`, with its proof of work.
    fn entry(who: &SigningKey, app: &str, site: &str, name: &str, ts: u64, deleted: bool) -> Entry {
        let app_key = sk(100);
        let mut e = Entry {
            by: pk(who),
            name: if deleted { String::new() } else { name.into() },
            desc: if deleted { String::new() } else { "a site".into() },
            ts,
            nonce: 0,
            sig: String::new(),
            cert: cert_for(who, app, &app_key),
            deleted,
        };
        let msg = entry_msg(site, &pk(who), &e);
        e.sig = hex::encode(app_key.sign(msg.as_bytes()).to_bytes());
        while zero_bits(&Sha256::digest(format!("{msg}|{}", e.nonce).as_bytes())) < POW_BITS {
            e.nonce += 1;
        }
        e
    }

    fn delta_of(site: &str, e: Entry) -> DirState {
        DirState { entries: [(site.to_string(), e)].into(), ..Default::default() }
    }

    fn admins_update(root: &SigningKey, ts: u64, list: Vec<String>) -> Admins {
        let msg = format!("fha1|{ts}|{}", list.join(","));
        Admins { ts, list, sig: hex::encode(root.sign(msg.as_bytes()).to_bytes()), cert: None }
    }

    #[test]
    fn only_admins_can_list_edit_and_delete_entries() {
        let p = params(); // root admin is sk(99)
        let mut s = DirState::default();
        assert!(validate(&p, &s).is_ok());

        // Non-admin cannot add an entry
        assert!(apply(&p, &mut s, delta_of(SITE, entry(&sk(1), APP, SITE, "Spam", 1, false))).is_err());

        // Root admin can add, and delegated admin can edit/delete
        let root = sk(99);
        let bob = sk(2);
        apply(&p, &mut s, DirState { admins: admins_update(&root, 1, vec![pk(&bob)]), ..Default::default() }).unwrap();

        let old = entry(&root, APP, SITE, "Old", 1, false);
        let new = entry(&bob, APP, SITE, "New", 2, false);
        for e in [new, old] {
            apply(&p, &mut s, delta_of(SITE, e)).unwrap();
        }
        assert_eq!(s.entries[SITE].name, "New"); // newest wins across admins, whatever the order
        assert_eq!(s.entries[SITE].by, pk(&bob));
        assert!(validate(&p, &s).is_ok());

        // Delegated for another app, or tampered name -> rejected
        assert!(apply(&p, &mut s, delta_of(SITE, entry(&bob, "/v1/contract/web/Other/", SITE, "X", 5, false))).is_err());
        let mut bad = entry(&bob, APP, SITE, "X", 5, false);
        bad.name = "Y".into();
        assert!(apply(&p, &mut s, delta_of(SITE, bad)).is_err());

        // A delta from a summary carries nothing when in sync
        let known = summarize(&s);
        assert_eq!(delta(&s, &known), DirState::default());
    }

    #[test]
    fn removing_a_delegated_admin_purges_their_entries_and_blocks_future_ones() {
        let p = params();
        let root = sk(99);
        let bob = sk(2);
        let mut s = DirState::default();

        // Add bob via Viso delegation from root
        let app_key = sk(101);
        let list = vec![pk(&bob)];
        let msg = format!("fha1|5|{}", list.join(","));
        let admins = Admins {
            ts: 5,
            list,
            sig: hex::encode(app_key.sign(msg.as_bytes()).to_bytes()),
            cert: Some(cert_for(&root, APP, &app_key)),
        };
        apply(&p, &mut s, DirState { admins, ..Default::default() }).unwrap();

        // Bob cannot modify the admins list
        let forged_admins = admins_update(&bob, 6, vec![pk(&sk(3))]);
        assert!(apply(&p, &mut s, DirState { admins: forged_admins, ..Default::default() }).is_err());

        // Bob adds a site
        apply(&p, &mut s, delta_of(SITE, entry(&bob, APP, SITE, "BobSite", 10, false))).unwrap();
        assert!(s.entries.contains_key(SITE));

        // Root removes Bob; Bob's entries are purged so state remains valid
        apply(&p, &mut s, DirState { admins: admins_update(&root, 20, vec![]), ..Default::default() }).unwrap();
        assert!(s.entries.is_empty());
        assert!(validate(&p, &s).is_ok());

        // Bob can no longer submit
        assert!(apply(&p, &mut s, delta_of(SITE, entry(&bob, APP, SITE, "Again", 30, false))).is_err());
    }

    #[test]
    fn the_admin_blocklist_hides_sites() {
        let p = params();
        let mut s = DirState::default();
        apply(&p, &mut s, delta_of(SITE, entry(&sk(99), APP, SITE, "Site", 1, false))).unwrap();
        let list = vec![SITE.to_string()];
        let sig = |k: &SigningKey| hex::encode(k.sign(format!("fhb1|5|{}", list.join(",")).as_bytes()).to_bytes());
        let forged = DirState { blocked: Blocklist { ts: 5, list: list.clone(), sig: sig(&sk(1)), cert: None }, ..Default::default() };
        assert!(apply(&p, &mut s, forged).is_err());
        apply(&p, &mut s, DirState { blocked: Blocklist { ts: 5, list: list.clone(), sig: sig(&sk(99)), cert: None }, ..Default::default() }).unwrap();
        assert!(s.entries.is_empty());
        // a blocked site cannot come back
        apply(&p, &mut s, delta_of(SITE, entry(&sk(99), APP, SITE, "Again", 9, false))).unwrap();
        assert!(s.entries.is_empty());
        assert!(validate(&p, &s).is_ok());
    }

    #[test]
    fn the_admin_blocklist_works_with_viso_delegation() {
        let p = params(); // admin is sk(99)
        let mut s = DirState::default();
        apply(&p, &mut s, delta_of(SITE, entry(&sk(99), APP, SITE, "Site", 1, false))).unwrap();
        assert_eq!(s.entries.len(), 1);

        let app_key = sk(101);
        let list = vec![SITE.to_string()];
        let msg = format!("fhb1|6|{}", list.join(","));
        let sig = hex::encode(app_key.sign(msg.as_bytes()).to_bytes());
        let blocked = Blocklist { ts: 6, list, sig, cert: Some(cert_for(&sk(99), APP, &app_key)) };

        apply(&p, &mut s, DirState { blocked, ..Default::default() }).unwrap();
        assert!(s.entries.is_empty());
        assert!(validate(&p, &s).is_ok());
    }

    #[test]
    fn entries_can_be_deleted_by_any_admin() {
        let p = params();
        let root = sk(99);
        let bob = sk(2);
        let mut s = DirState::default();
        apply(&p, &mut s, DirState { admins: admins_update(&root, 1, vec![pk(&bob)]), ..Default::default() }).unwrap();
        apply(&p, &mut s, delta_of(SITE, entry(&root, APP, SITE, "Site", 1, false))).unwrap();
        assert!(!s.entries[SITE].deleted);

        // Bob deletes the site listed by root; tombstone stays and prevents older delta resurrection
        apply(&p, &mut s, delta_of(SITE, entry(&bob, APP, SITE, "", 2, true))).unwrap();
        assert!(s.entries[SITE].deleted);
        apply(&p, &mut s, delta_of(SITE, entry(&root, APP, SITE, "Site", 1, false))).unwrap();
        assert!(s.entries[SITE].deleted);
        assert!(validate(&p, &s).is_ok());
    }
}
