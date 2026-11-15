// A made-up module, for the tests of `howl trace`.

pub fn limit(now: f32, target: f32) -> f32 {
    if target > now + 2.5 { now + 2.5 } else { target }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn req_brk_010_a_released_pedal_asks_for_no_pressure() {
        assert_eq!(limit(0.0, 0.0), 0.0);
    }

    /// touches: REQ-BRK-013
    #[test]
    fn req_brk_012_a_rise_is_limited_per_cycle() {
        assert_eq!(limit(0.0, 10.0), 2.5);
    }

    #[test]
    #[should_panic]
    fn req_brk_012_a_small_rise_reaches_the_target() {
        assert_eq!(limit(0.0, 1.0), 2.0);
    }

    // covers: REQ-BRK-011, req_brk_012
    #[test]
    fn the_limits_hold_together() {
        assert_eq!(limit(5.0, 6.0), 6.0);
    }

    #[test]
    fn req_brk_051_a_fault_is_counted_once() {}

    #[test]
    fn rounding_is_to_nearest() {}

    fn helper_that_is_no_test() {}
}
