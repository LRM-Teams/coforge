use std::sync::{Arc, Mutex};

use ureq::unversioned::transport::LazyBuffers;

use super::*;

const IDLE: Duration = Duration::from_secs(60);

fn wait(after: WaitLimit, reason: Timeout) -> NextTimeout {
    NextTimeout { after, reason }
}

#[test]
fn a_wait_with_no_deadline_is_bounded_by_the_idle_limit_as_a_body_wait() {
    // With nothing configured for the phase, ureq reports "never" under the name `Global`.
    let bounded = bounded(wait(WaitLimit::NotHappening, Timeout::Global), IDLE);

    assert_eq!(bounded.after, WaitLimit::Exact(IDLE));
    assert_eq!(bounded.reason, Timeout::RecvBody);
}

#[test]
fn a_farther_deadline_is_shortened_and_keeps_the_phase_it_belongs_to() {
    let bounded = bounded(
        wait(WaitLimit::from_secs(3600), Timeout::RecvResponse),
        IDLE,
    );

    assert_eq!(bounded.after, WaitLimit::Exact(IDLE));
    assert_eq!(bounded.reason, Timeout::RecvResponse);
}

#[test]
fn a_nearer_deadline_is_never_extended() {
    for reason in [Timeout::RecvResponse, Timeout::RecvBody, Timeout::Global] {
        for after in [WaitLimit::from_millis(100), WaitLimit::Exact(IDLE)] {
            let original = wait(after, reason);

            assert_eq!(bounded(original, IDLE), original, "{after:?} {reason:?}");
        }
    }
}

/// A transport that only records the timeouts it is asked to wait with.
#[derive(Debug)]
struct Recording {
    seen: Arc<Mutex<Vec<NextTimeout>>>,
    buffers: LazyBuffers,
}

impl Transport for Recording {
    fn buffers(&mut self) -> &mut dyn Buffers {
        &mut self.buffers
    }

    fn transmit_output(
        &mut self,
        _amount: usize,
        _timeout: NextTimeout,
    ) -> Result<(), ureq::Error> {
        Ok(())
    }

    fn await_input(&mut self, timeout: NextTimeout) -> Result<bool, ureq::Error> {
        self.seen.lock().unwrap().push(timeout);
        Ok(true)
    }

    fn is_open(&mut self) -> bool {
        true
    }
}

#[test]
fn the_wrapper_waits_with_the_bounded_timeout() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let mut transport = IdleTimeout {
        inner: Box::new(Recording {
            seen: Arc::clone(&seen),
            buffers: LazyBuffers::new(1024, 1024),
        }),
        idle: IDLE,
    };

    transport
        .await_input(wait(WaitLimit::NotHappening, Timeout::Global))
        .unwrap();
    transport
        .await_input(wait(WaitLimit::from_millis(100), Timeout::RecvResponse))
        .unwrap();

    let seen = seen.lock().unwrap();
    assert_eq!(seen[0].after, WaitLimit::Exact(IDLE));
    assert_eq!(seen[1].after, WaitLimit::from_millis(100));
}
