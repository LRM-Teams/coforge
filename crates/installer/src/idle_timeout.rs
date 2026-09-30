//! A bound on how long a transfer may sit silent.
//!
//! ureq offers no per-read timeout: `timeout_recv_body` is one budget for the whole body ("the
//! budget is not restarted for each read", <https://docs.rs/ureq/3.4.2/ureq/config/struct.ConfigBuilder.html#method.timeout_recv_body>),
//! and `timeout_global` covers the whole call. Either would cut off a 140 MB download on a
//! slow link that is still making progress. What a stalled server needs is a bound on each wait
//! for input, so this wraps ureq's transport and lowers the timeout of every `await_input` to
//! the idle limit. A read that receives data resets it; a read that receives nothing for the
//! limit fails with a timeout.
//!
//! **This file depends on an API with no stability guarantee.** `Transport`, `Connector`, and
//! `NextTimeout` live in ureq's `unversioned` module, which its docs describe as "API that does not
//! (yet) follow semver": it may change, or stop compiling, in any ureq minor release
//! (<https://docs.rs/ureq/3.4.2/ureq/unversioned/index.html>,
//! <https://docs.rs/ureq/3.4.2/ureq/unversioned/transport/index.html>). `Cargo.lock` pins ureq,
//! and every cargo command runs with `--locked`, so a bump is always a deliberate change that
//! starts by fixing this file. The stall test in `fetch/tests.rs` fails loudly if an update ever
//! compiles but stops applying the limit.

use std::time::Duration;

use ureq::Timeout;
use ureq::unversioned::transport::time::Duration as WaitLimit;
use ureq::unversioned::transport::{
    Buffers, ConnectionDetails, Connector, DefaultConnector, NextTimeout, Transport,
};

/// ureq's default connector (TCP, TLS) with every wait for input bounded by `idle`.
pub fn connector(idle: Duration) -> impl Connector {
    DefaultConnector::new().chain(IdleTimeoutConnector { idle })
}

#[derive(Debug)]
struct IdleTimeoutConnector {
    idle: Duration,
}

impl Connector<Box<dyn Transport>> for IdleTimeoutConnector {
    type Out = IdleTimeout;

    fn connect(
        &self,
        _details: &ConnectionDetails,
        chained: Option<Box<dyn Transport>>,
    ) -> Result<Option<Self::Out>, ureq::Error> {
        Ok(chained.map(|inner| IdleTimeout {
            inner,
            idle: self.idle,
        }))
    }
}

#[derive(Debug)]
struct IdleTimeout {
    inner: Box<dyn Transport>,
    idle: Duration,
}

impl Transport for IdleTimeout {
    fn buffers(&mut self) -> &mut dyn Buffers {
        self.inner.buffers()
    }

    fn transmit_output(&mut self, amount: usize, timeout: NextTimeout) -> Result<(), ureq::Error> {
        self.inner.transmit_output(amount, timeout)
    }

    fn await_input(&mut self, timeout: NextTimeout) -> Result<bool, ureq::Error> {
        self.inner.await_input(bounded(timeout, self.idle))
    }

    fn is_open(&mut self) -> bool {
        self.inner.is_open()
    }

    fn is_tls(&self) -> bool {
        self.inner.is_tls()
    }
}

/// `timeout`, unless that is later than `idle` from now: then `idle`. A deadline that is already
/// nearer stays as it is, so the limit only ever shortens a wait.
///
/// The reason stays the phase ureq is waiting in. ureq reports an unbounded wait as `Global`;
/// the only such wait is for the body (the headers have `timeout_recv_response`), so it is
/// named that.
fn bounded(timeout: NextTimeout, idle: Duration) -> NextTimeout {
    if *timeout.after <= idle {
        return timeout;
    }
    NextTimeout {
        after: WaitLimit::Exact(idle),
        reason: match timeout.reason {
            Timeout::Global => Timeout::RecvBody,
            phase => phase,
        },
    }
}

#[cfg(test)]
mod tests;
