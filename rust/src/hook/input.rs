// The JSON a hook gets on standard input, read as JSON.parse reads it: at any depth, the last value of a key given twice
// (#141). Only what the hook may use is built: the top-level object, the objects in it (as `tool_input` and `effort`),
// and the texts in those. Everything else is checked to be JSON and dropped here, in the hook's own process.
//
// The reader goes without recursion, so that no nesting can end the process: V8's JSON.parse reads any depth too.
// @code_class recording

/// A value of the input, as far as the hook looks at it.
#[derive(Debug, Clone, PartialEq)]
pub enum Json {
    /// A text, and whether it held a `\u` escape of a lone surrogate, which stands as U+FFFD in the text.
    Text(String, bool),
    /// An object near the top, its members in order.
    Object(Members),
    /// Anything else: a number, a literal, an array, an object too deep to be used, a text in one of those.
    Other,
}

/// The members of an object, a key given twice included.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Members(Vec<(String, Json)>);

impl Members {
    /// The value of a key: the last one given, as JSON.parse keeps it.
    pub fn get(&self, key: &str) -> Option<&Json> {
        self.0.iter().rev().find(|(k, _)| k == key).map(|(_, v)| v)
    }
}

/// An array or an object being read.
enum Frame {
    Array,
    /// An object; its members when it is built, with the key of the value being read.
    Object(Option<(Members, String)>),
}

struct Reader<'a> {
    text: &'a str,
    bytes: &'a [u8],
    at: usize,
}

impl Reader<'_> {
    fn blank(&mut self) {
        while matches!(self.bytes.get(self.at), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.at += 1;
        }
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.at).copied()
    }

    fn eat(&mut self, byte: u8) -> Option<()> {
        (self.peek()? == byte).then(|| self.at += 1)
    }

    fn word(&mut self, word: &str) -> Option<()> {
        let end = self.at + word.len();
        (self.bytes.get(self.at..end)? == word.as_bytes()).then(|| self.at = end)
    }

    fn digits(&mut self) -> usize {
        let start = self.at;
        while self.peek().is_some_and(|b| b.is_ascii_digit()) {
            self.at += 1;
        }
        self.at - start
    }

    fn number(&mut self) -> Option<()> {
        let _ = self.eat(b'-');
        if self.eat(b'0').is_none() && self.digits() == 0 {
            return None;
        }
        if self.eat(b'.').is_some() && self.digits() == 0 {
            return None;
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.at += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.at += 1;
            }
            if self.digits() == 0 {
                return None;
            }
        }
        Some(())
    }

    fn hex4(&mut self) -> Option<u32> {
        let hex = self.text.get(self.at..self.at + 4)?;
        if !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        self.at += 4;
        u32::from_str_radix(hex, 16).ok()
    }

    /// A text from its opening quote; built only when `keep`, with whether it held a lone surrogate.
    fn string(&mut self, keep: bool) -> Option<Option<(String, bool)>> {
        self.eat(b'"')?;
        let mut out = String::new();
        let mut lone = false;
        let mut run = self.at;
        loop {
            let byte = self.peek()?;
            match byte {
                b'"' => {
                    if keep {
                        out.push_str(&self.text[run..self.at]);
                    }
                    self.at += 1;
                    return Some(keep.then_some((out, lone)));
                }
                0..=0x1f => return None,
                b'\\' => {
                    if keep {
                        out.push_str(&self.text[run..self.at]);
                    }
                    self.at += 1;
                    let escape = self.peek()?;
                    self.at += 1;
                    let c = match escape {
                        b'"' => '"',
                        b'\\' => '\\',
                        b'/' => '/',
                        b'b' => '\u{8}',
                        b'f' => '\u{c}',
                        b'n' => '\n',
                        b'r' => '\r',
                        b't' => '\t',
                        b'u' => {
                            let unit = self.hex4()?;
                            self.unit(unit, &mut lone)
                        }
                        _ => return None,
                    };
                    if keep {
                        out.push(c);
                    }
                    run = self.at;
                }
                _ => self.at += 1,
            }
        }
    }

    /// The character of a `\u` escape, with the low half of a pair when one follows; U+FFFD for a lone half.
    fn unit(&mut self, unit: u32, lone: &mut bool) -> char {
        let escape_follows = self.bytes.get(self.at..self.at + 2) == Some(b"\\u");
        if (0xd800..0xdc00).contains(&unit) && escape_follows {
            let back = self.at;
            self.at += 2;
            match self.hex4() {
                Some(low) if (0xdc00..0xe000).contains(&low) => {
                    let c = 0x10000 + ((unit - 0xd800) << 10) + (low - 0xdc00);
                    return char::from_u32(c).unwrap_or('\u{fffd}');
                }
                _ => self.at = back,
            }
        }
        char::from_u32(unit).unwrap_or_else(|| {
            *lone = true;
            '\u{fffd}'
        })
    }

    /// After `{` and the blanks: the key of a member and its colon.
    fn key(&mut self, keep: bool) -> Option<String> {
        let key = self.string(keep)?.map(|(key, _)| key).unwrap_or_default();
        self.blank();
        self.eat(b':')?;
        Some(key)
    }
}

/// The input of a hook as JSON.parse would read it, or none when it is not JSON.
pub fn read_input(text: &str) -> Option<Json> {
    let mut r = Reader {
        text,
        bytes: text.as_bytes(),
        at: 0,
    };
    let mut stack: Vec<Frame> = Vec::new();
    loop {
        // A value starts.
        r.blank();
        let built_parent = stack
            .last()
            .is_none_or(|f| matches!(f, Frame::Object(Some(_))));
        // Texts are built in a built object; objects only down to the second level.
        let keep_text = built_parent;
        let keep_object = built_parent && stack.len() < 2;
        let mut value = match r.peek()? {
            b'{' => {
                r.at += 1;
                r.blank();
                if r.eat(b'}').is_some() {
                    if keep_object {
                        Json::Object(Members::default())
                    } else {
                        Json::Other
                    }
                } else {
                    let key = r.key(keep_object)?;
                    stack.push(Frame::Object(
                        keep_object.then(|| (Members::default(), key)),
                    ));
                    continue;
                }
            }
            b'[' => {
                r.at += 1;
                r.blank();
                if r.eat(b']').is_some() {
                    Json::Other
                } else {
                    stack.push(Frame::Array);
                    continue;
                }
            }
            b'"' => match r.string(keep_text)? {
                Some((text, lone)) => Json::Text(text, lone),
                None => Json::Other,
            },
            b'-' | b'0'..=b'9' => {
                r.number()?;
                Json::Other
            }
            b't' => r.word("true").map(|_| Json::Other)?,
            b'f' => r.word("false").map(|_| Json::Other)?,
            b'n' => r.word("null").map(|_| Json::Other)?,
            _ => return None,
        };
        // A value ends: it goes into its array or object, which may end too.
        loop {
            let Some(frame) = stack.last_mut() else {
                r.blank();
                return (r.at == r.bytes.len()).then_some(value);
            };
            let object = matches!(frame, Frame::Object(_));
            if let Frame::Object(Some((members, key))) = frame {
                members.0.push((std::mem::take(key), value));
            }
            r.blank();
            match r.peek()? {
                b',' => {
                    r.at += 1;
                    if let Frame::Object(built) = frame {
                        r.blank();
                        let key = r.key(built.is_some())?;
                        if let Some((_, slot)) = built {
                            *slot = key;
                        }
                    }
                    break;
                }
                b'}' if object => {}
                b']' if !object => {}
                _ => return None,
            }
            r.at += 1;
            value = match stack.pop() {
                Some(Frame::Object(Some((members, _)))) => Json::Object(members),
                _ => Json::Other,
            };
        }
    }
}
