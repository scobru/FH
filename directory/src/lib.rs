//! Public directory of Freenet apps. One shared instance; parameters = admin ed25519 pubkey (32 bytes) || app path
//! (`/v1/contract/web/<FH id>/`). Anyone signed in to FH (a whoiam persona, through an app key delegated for that
//! app path, see `whoiam-delegation`) lists a site with a name and a short description, plus a proof-of-work nonce.
//! Entries are kept per (site, persona), newest wins, so every merge order converges; the UI shows each site once.
//! The admin hides sites with a signed blocklist. The newest MAX_ENTRIES entries are kept. State is JSON.
use freenet_stdlib::prelude::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use whoiam_delegation::{check, key, verify, Cert, R};

pub const POW_BITS: u32 = 18;
pub const MAX_ENTRIES: usize = 1000;
const MAX_NAME: usize = 60;
const MAX_DESC: usize = 200;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Entry {
    pub name: String,
    pub desc: String,
    pub ts: u64,
    pub nonce: u64,
    pub sig: String, // hex, by the persona's delegated app key over `fhd1|<site>|<persona>|<name>|<desc>|<ts>`
    pub cert: Cert,  // the persona's delegation to that key
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Blocklist {
    pub ts: u64,
    pub list: Vec<String>, // site keys
    pub sig: String,       // hex, by admin over `fhb1|<ts>|<list joined by ,>`
}

/// Also the delta: an update carries the entries and blocklist to merge.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct DirState {
    #[serde(default)]
    pub entries: BTreeMap<String, BTreeMap<String, Entry>>, // site key (base58) -> persona (hex) -> entry
    #[serde(default)]
    pub blocked: Blocklist,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Summary {
    pub entries: BTreeMap<String, BTreeMap<String, u64>>,
    pub blocked_ts: u64,
}

pub fn entry_msg(site: &str, persona: &str, e: &Entry) -> String {
    format!("fhd1|{site}|{persona}|{}|{}|{}", e.name, e.desc, e.ts)
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

fn text_ok(s: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&s.chars().count()) && !s.chars().any(char::is_control) && !s.contains('|')
}

fn check_entry(app: &str, site: &str, persona: &str, e: &Entry) -> R<()> {
    if !is_site(site) || !text_ok(&e.name, 1, MAX_NAME) || !text_ok(&e.desc, 0, MAX_DESC) {
        return Err("bad entry".into());
    }
    let msg = entry_msg(site, persona, e);
    verify(&check(persona, app, &e.cert)?, msg.as_bytes(), &e.sig)?;
    if zero_bits(&Sha256::digest(format!("{msg}|{}", e.nonce).as_bytes())) < POW_BITS {
        return Err("insufficient proof of work".into());
    }
    Ok(())
}

fn check_blocklist(admin: &str, b: &Blocklist) -> R<()> {
    if *b == Blocklist::default() {
        return Ok(()); // initial empty state
    }
    if b.list.len() > 10_000 || !b.list.iter().all(|s| is_site(s)) {
        return Err("bad blocklist".into());
    }
    verify(&key(admin)?, format!("fhb1|{}|{}", b.ts, b.list.join(",")).as_bytes(), &b.sig)
}

fn split(params: &str) -> R<(String, String)> {
    let raw = hex::decode(params).map_err(|e| e.to_string())?;
    let app = std::str::from_utf8(raw.get(32..).ok_or("params too short")?).map_err(|e| e.to_string())?;
    Ok((params[..64].to_string(), app.to_string()))
}

/// Keep the newest `max` entries; deterministic, so merge order does not matter.
fn prune(s: &mut DirState, max: usize) {
    let mut all: Vec<_> = s.entries.iter().flat_map(|(site, m)| m.iter().map(move |(p, e)| (std::cmp::Reverse(e.ts), site.clone(), p.clone()))).collect();
    if all.len() <= max {
        return;
    }
    all.sort();
    for (_, site, p) in all.into_iter().skip(max) {
        let m = s.entries.get_mut(&site).unwrap();
        m.remove(&p);
        if m.is_empty() {
            s.entries.remove(&site);
        }
    }
}

pub fn validate(params: &str, s: &DirState) -> R<()> {
    let (admin, app) = split(params)?;
    check_blocklist(&admin, &s.blocked)?;
    if s.entries.values().map(BTreeMap::len).sum::<usize>() > MAX_ENTRIES || s.entries.keys().any(|k| s.blocked.list.contains(k)) {
        return Err("state out of bounds".into());
    }
    s.entries.iter().try_for_each(|(site, m)| m.iter().try_for_each(|(p, e)| check_entry(&app, site, p, e)))
}

/// Merge `d` into `s`. Invalid parts of `d` are an error, so a bad update is refused as a whole.
pub fn apply(params: &str, s: &mut DirState, d: DirState) -> R<()> {
    let (admin, app) = split(params)?;
    if d.blocked.ts > s.blocked.ts {
        check_blocklist(&admin, &d.blocked)?;
        s.blocked = d.blocked;
    }
    for (site, m) in d.entries {
        for (p, e) in m {
            check_entry(&app, &site, &p, &e)?;
            let cur = s.entries.entry(site.clone()).or_default();
            if cur.get(&p).is_none_or(|old| (e.ts, &e.sig) > (old.ts, &old.sig)) {
                cur.insert(p, e);
            }
        }
    }
    let blocked = s.blocked.list.clone();
    s.entries.retain(|site, m| !m.is_empty() && !blocked.contains(site));
    prune(s, MAX_ENTRIES);
    Ok(())
}

pub fn summarize(s: &DirState) -> Summary {
    Summary {
        entries: s.entries.iter().map(|(site, m)| (site.clone(), m.iter().map(|(p, e)| (p.clone(), e.ts)).collect())).collect(),
        blocked_ts: s.blocked.ts,
    }
}

pub fn delta(s: &DirState, known: &Summary) -> DirState {
    let newer = |site: &str, p: &str, e: &Entry| known.entries.get(site).and_then(|m| m.get(p)).is_none_or(|ts| e.ts > *ts);
    DirState {
        entries: s.entries.iter()
            .map(|(site, m)| (site.clone(), m.iter().filter(|(p, e)| newer(site, p, e)).map(|(p, e)| (p.clone(), e.clone())).collect::<BTreeMap<_, _>>()))
            .filter(|(_, m)| !m.is_empty())
            .collect(),
        blocked: if s.blocked.ts > known.blocked_ts { s.blocked.clone() } else { Blocklist::default() },
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

    /// `who`'s entry for `site`, signed by an app key delegated for `app`, with its proof of work.
    fn entry(who: &SigningKey, app: &str, site: &str, name: &str, ts: u64) -> (String, Entry) {
        let app_key = sk(100);
        let (base, challenge) = (format!("http://127.0.0.1:7509{app}"), format!("wd1.{}.n1", pk(&app_key)));
        let csig = who.sign(&connect_message(who.verifying_key().as_bytes(), &base, &challenge, 1));
        let mut e = Entry { name: name.into(), desc: "a site".into(), ts, nonce: 0, sig: String::new(), cert: Cert { base, challenge, ts: 1, sig: hex::encode(csig.to_bytes()) } };
        let msg = entry_msg(site, &pk(who), &e);
        e.sig = hex::encode(app_key.sign(msg.as_bytes()).to_bytes());
        while zero_bits(&Sha256::digest(format!("{msg}|{}", e.nonce).as_bytes())) < POW_BITS {
            e.nonce += 1;
        }
        (pk(who), e)
    }
    fn delta_of(site: &str, (p, e): (String, Entry)) -> DirState {
        DirState { entries: [(site.to_string(), [(p, e)].into())].into(), ..Default::default() }
    }

    #[test]
    fn entries_merge_per_persona_and_bad_ones_are_refused() {
        let p = params();
        let mut s = DirState::default();
        assert!(validate(&p, &s).is_ok());
        let (old, new, other) = (entry(&sk(1), APP, SITE, "Old", 1), entry(&sk(1), APP, SITE, "New", 2), entry(&sk(2), APP, SITE, "Other", 1));
        for d in [new.clone(), old.clone(), other.clone()] {
            apply(&p, &mut s, delta_of(SITE, d)).unwrap();
        }
        assert_eq!(s.entries[SITE][&pk(&sk(1))].name, "New"); // newest per persona, whatever the order
        assert_eq!(s.entries[SITE].len(), 2);
        assert!(validate(&p, &s).is_ok());
        // delegated for another app, tampered name
        assert!(apply(&p, &mut s, delta_of(SITE, entry(&sk(3), "/v1/contract/web/Other/", SITE, "X", 5))).is_err());
        let (who, mut e) = entry(&sk(3), APP, SITE, "X", 5);
        e.name = "Y".into();
        assert!(apply(&p, &mut s, delta_of(SITE, (who, e))).is_err());
        // a delta from a summary carries only what is newer
        let known = summarize(&s);
        assert_eq!(delta(&s, &known), DirState::default());
    }

    #[test]
    fn the_admin_blocklist_hides_sites() {
        let p = params();
        let mut s = DirState::default();
        apply(&p, &mut s, delta_of(SITE, entry(&sk(1), APP, SITE, "Site", 1))).unwrap();
        let list = vec![SITE.to_string()];
        let sig = |k: &SigningKey| hex::encode(k.sign(format!("fhb1|5|{}", list.join(",")).as_bytes()).to_bytes());
        let forged = DirState { blocked: Blocklist { ts: 5, list: list.clone(), sig: sig(&sk(1)) }, ..Default::default() };
        assert!(apply(&p, &mut s, forged).is_err());
        apply(&p, &mut s, DirState { blocked: Blocklist { ts: 5, list: list.clone(), sig: sig(&sk(99)) }, ..Default::default() }).unwrap();
        assert!(s.entries.is_empty());
        // a blocked site cannot come back
        apply(&p, &mut s, delta_of(SITE, entry(&sk(2), APP, SITE, "Again", 9))).unwrap();
        assert!(s.entries.is_empty());
        assert!(validate(&p, &s).is_ok());
    }
}
