//! A persona's site list, so FH shows the same tiles on every node. One instance per persona and app.
//! Parameters = owner (a whoiam persona, ed25519 pubkey, 32 bytes) || app path (`/v1/contract/web/<FH id>/`).
//! State is JSON: the list as the exact signed string, its timestamp, the signature by an app key the persona
//! delegated for that app path (see `whoiam-delegation`), and the delegation. The newest signed list wins.
use freenet_stdlib::prelude::*;
use serde::{Deserialize, Serialize};
use whoiam_delegation::{check, verify, Cert, R};

const MAX_LIST: usize = 64 * 1024;

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct ListState {
    pub list: String, // the sites, JSON, kept as signed
    pub ts: u64,
    pub sig: String,          // hex, by the delegated app key, over `fhl1|<params_hex>|<ts>|<list>`
    pub cert: Option<Cert>,   // the owner's delegation to that key
}

/// An empty state (nothing published yet) is valid; anything else must be signed for this persona and app.
pub fn validate(params: &str, s: &ListState) -> R<()> {
    if *s == ListState::default() {
        return Ok(());
    }
    if s.list.len() > MAX_LIST {
        return Err("list too large".into());
    }
    let raw = hex::decode(params).map_err(|e| e.to_string())?;
    let app = std::str::from_utf8(raw.get(32..).ok_or("params too short")?).map_err(|e| e.to_string())?;
    let app_key = check(&params[..64], app, s.cert.as_ref().ok_or("list without delegation")?)?;
    verify(&app_key, format!("fhl1|{params}|{}|{}", s.ts, s.list).as_bytes(), &s.sig)
}

/// Keep the newer of two valid states; equal timestamps break on the signature, so every merge order converges.
pub fn merge(params: &str, s: &mut ListState, other: ListState) -> R<()> {
    validate(params, &other)?;
    if (other.ts, &other.sig) > (s.ts, &s.sig) {
        *s = other;
    }
    Ok(())
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
        let mut s: ListState = de(state.as_ref())?;
        for u in data {
            // a delta is a whole state too: the list is replaced, never patched
            let other: ListState = match u {
                UpdateData::State(st) => de(st.as_ref())?,
                UpdateData::Delta(d) => de(d.as_ref())?,
                UpdateData::StateAndDelta { delta, .. } => de(delta.as_ref())?,
                _ => return Err(ContractError::InvalidUpdate),
            };
            merge(&params, &mut s, other).map_err(|_| ContractError::InvalidUpdate)?;
        }
        Ok(UpdateModification::valid(State::from(ser(&s)?)))
    }

    fn summarize_state(
        _parameters: Parameters<'static>,
        state: State<'static>,
    ) -> Result<StateSummary<'static>, ContractError> {
        let s: ListState = de(state.as_ref())?;
        Ok(StateSummary::from(ser(&(s.ts, s.sig))?))
    }

    fn get_state_delta(
        _parameters: Parameters<'static>,
        state: State<'static>,
        summary: StateSummary<'static>,
    ) -> Result<StateDelta<'static>, ContractError> {
        let s: ListState = de(state.as_ref())?;
        let known: (u64, String) = de(summary.as_ref())?;
        // the empty state merges as a no-op, so it stands for "nothing newer"
        Ok(StateDelta::from(ser(&if (s.ts, &s.sig) > (known.0, &known.1) { s } else { ListState::default() })?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use whoiam_delegation::connect_message;

    const APP: &str = "/v1/contract/web/FH1/";
    fn sk(n: u8) -> SigningKey { SigningKey::from_bytes(&[n; 32]) }
    fn pk(k: &SigningKey) -> String { hex::encode(k.verifying_key().as_bytes()) }
    fn params(o: &SigningKey) -> String { format!("{}{}", pk(o), hex::encode(APP)) }

    /// `o`'s list signed by app key `app_key`, delegated on some node for `app`.
    fn signed(o: &SigningKey, params: &str, app: &str, app_key: &SigningKey, ts: u64, list: &str) -> ListState {
        let (base, challenge) = (format!("http://127.0.0.1:7509{app}"), format!("wd1.{}.n1", pk(app_key)));
        let csig = o.sign(&connect_message(o.verifying_key().as_bytes(), &base, &challenge, 1));
        let cert = Cert { base, challenge, ts: 1, sig: hex::encode(csig.to_bytes()) };
        let sig = hex::encode(app_key.sign(format!("fhl1|{params}|{ts}|{list}").as_bytes()).to_bytes());
        ListState { list: list.into(), ts, sig, cert: Some(cert) }
    }

    #[test]
    fn only_the_owner_writes_and_the_newest_list_wins() {
        let (o, p) = (sk(1), params(&sk(1)));
        let mut s = ListState::default();
        assert!(validate(&p, &s).is_ok());
        // two nodes, two app keys, one persona: both write, the newer list is kept in either order
        let (a, b) = (signed(&o, &p, APP, &sk(10), 5, "[1]"), signed(&o, &p, APP, &sk(11), 9, "[2]"));
        merge(&p, &mut s, a.clone()).unwrap();
        merge(&p, &mut s, b.clone()).unwrap();
        merge(&p, &mut s, a.clone()).unwrap();
        assert_eq!(s, b);
        // another persona, another app, a tampered list
        assert!(merge(&p, &mut s, signed(&sk(2), &p, APP, &sk(10), 20, "[3]")).is_err());
        assert!(merge(&p, &mut s, signed(&o, &p, "/v1/contract/web/Other/", &sk(10), 20, "[3]")).is_err());
        let mut forged = signed(&o, &p, APP, &sk(10), 20, "[3]");
        forged.list = "[4]".into();
        assert!(merge(&p, &mut s, forged).is_err());
        assert_eq!(s, b);
        assert!(validate(&p, &signed(&o, &p, APP, &sk(10), 1, &"x".repeat(MAX_LIST + 1))).is_err());
    }
}
