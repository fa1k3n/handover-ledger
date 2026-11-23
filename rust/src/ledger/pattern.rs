// The patterns of the schema, matched as JavaScript's RegExp with the `u` flag matches them (#140).
//
// A small matcher of our own, not a crate: it knows only what the schema's patterns use (`^`, `$`, literals, `\.` and
// `\uXXXX`, classes with ranges and `^`, groups with `|`, `?`, `*`, `+`, `{n}`, `{n,}`, `{n,m}`), over code points.
// Anything else is refused when the pattern is read, so a schema that needs more fails its test instead of passing.
// @code_class evidence

/// A pattern, read once.
#[derive(Debug, Clone)]
pub struct Pattern {
    /// The whole pattern, as one group of its alternatives.
    whole: [Node; 1],
}

#[derive(Debug, Clone)]
enum Node {
    Char(char),
    Class { ranges: Vec<(char, char)>, negated: bool },
    Start,
    End,
    Group(Vec<Vec<Node>>),
    Repeat { node: Box<Node>, min: u32, max: Option<u32> },
}

impl Pattern {
    /// Reads a pattern; a construct the matcher does not know is refused, named.
    pub fn new(source: &str) -> Result<Pattern, String> {
        let chars: Vec<char> = source.chars().collect();
        let mut reader = Reader { chars: &chars, at: 0 };
        let alternatives = reader.alternatives()?;
        if reader.at < chars.len() {
            return Err(format!("the pattern {source:?} has an unmatched ')'"));
        }
        Ok(Pattern { whole: [Node::Group(alternatives)] })
    }

    /// Whether the pattern is found in `text`, as RegExp.prototype.test finds it: anywhere, unless anchored.
    pub fn is_match(&self, text: &str) -> bool {
        let text: Vec<char> = text.chars().collect();
        (0..=text.len()).any(|start| sequence(&self.whole, start, &text, &mut |_| true))
    }
}

struct Reader<'a> {
    chars: &'a [char],
    at: usize,
}

impl Reader<'_> {
    fn peek(&self) -> Option<char> {
        self.chars.get(self.at).copied()
    }

    fn next(&mut self) -> Result<char, String> {
        let c = self.peek().ok_or("the pattern ends too soon")?;
        self.at += 1;
        Ok(c)
    }

    fn alternatives(&mut self) -> Result<Vec<Vec<Node>>, String> {
        let mut all = vec![self.sequence()?];
        while self.peek() == Some('|') {
            self.at += 1;
            all.push(self.sequence()?);
        }
        Ok(all)
    }

    fn sequence(&mut self) -> Result<Vec<Node>, String> {
        let mut nodes = Vec::new();
        while let Some(c) = self.peek() {
            if c == '|' || c == ')' {
                break;
            }
            let atom = self.atom()?;
            nodes.push(self.quantified(atom)?);
        }
        Ok(nodes)
    }

    fn atom(&mut self) -> Result<Node, String> {
        match self.next()? {
            '^' => Ok(Node::Start),
            '$' => Ok(Node::End),
            '(' => {
                if self.peek() == Some('?') {
                    self.at += 1;
                    if self.next()? != ':' {
                        return Err("the pattern construct (? other than (?: is not known".into());
                    }
                }
                let inner = self.alternatives()?;
                if self.next()? != ')' {
                    return Err("the pattern has an unclosed '('".into());
                }
                Ok(Node::Group(inner))
            }
            '[' => self.class(),
            '\\' => Ok(Node::Char(self.escape()?)),
            c @ ('.' | '*' | '+' | '?' | '{' | '}' | ']') => {
                Err(format!("the pattern construct {c} is not known here"))
            }
            c => Ok(Node::Char(c)),
        }
    }

    /// The character of an escape, after its `\`.
    fn escape(&mut self) -> Result<char, String> {
        match self.next()? {
            'u' => {
                let mut code = 0u32;
                for _ in 0..4 {
                    let digit = self.next()?.to_digit(16).ok_or("the pattern has a \\u without four hex digits")?;
                    code = code * 16 + digit;
                }
                char::from_u32(code).ok_or_else(|| format!("the pattern escape \\u{code:04x} is half a surrogate pair"))
            }
            c @ ('^' | '$' | '\\' | '.' | '*' | '+' | '?' | '(' | ')' | '[' | ']' | '{' | '}' | '|' | '/' | '-') => Ok(c),
            c => Err(format!("the pattern escape \\{c} is not known")),
        }
    }

    fn class(&mut self) -> Result<Node, String> {
        let negated = self.peek() == Some('^');
        if negated {
            self.at += 1;
        }
        let mut ranges = Vec::new();
        loop {
            let low = match self.next()? {
                ']' => break,
                '\\' => self.escape()?,
                '[' => return Err("the pattern construct [ inside a class is not known".into()),
                c => c,
            };
            let ranged = self.peek() == Some('-') && self.chars.get(self.at + 1).is_some_and(|&c| c != ']');
            if !ranged {
                ranges.push((low, low));
                continue;
            }
            self.at += 1;
            let high = match self.next()? {
                '\\' => self.escape()?,
                c => c,
            };
            if high < low {
                return Err(format!("the pattern range {low}-{high} is out of order"));
            }
            ranges.push((low, high));
        }
        Ok(Node::Class { ranges, negated })
    }

    fn quantified(&mut self, atom: Node) -> Result<Node, String> {
        let (min, max) = match self.peek() {
            Some('*') => (0, None),
            Some('+') => (1, None),
            Some('?') => (0, Some(1)),
            Some('{') => {
                self.at += 1;
                let min = self.number()?;
                let max = match self.next()? {
                    '}' => Some(min),
                    ',' if self.peek() == Some('}') => {
                        self.at += 1;
                        None
                    }
                    ',' => {
                        let max = self.number()?;
                        if self.next()? != '}' {
                            return Err("the pattern has an unclosed '{'".into());
                        }
                        Some(max)
                    }
                    _ => return Err("the pattern has an unclosed '{'".into()),
                };
                if max.is_some_and(|max| max < min) {
                    return Err("the pattern has a {n,m} with m below n".into());
                }
                return self.repeat(atom, min, max);
            }
            _ => return Ok(atom),
        };
        self.at += 1;
        self.repeat(atom, min, max)
    }

    fn repeat(&mut self, atom: Node, min: u32, max: Option<u32>) -> Result<Node, String> {
        if matches!(atom, Node::Start | Node::End) {
            return Err("the pattern repeats an anchor".into());
        }
        if matches!(self.peek(), Some('?' | '*' | '+' | '{')) {
            return Err("the pattern construct of a lazy or double quantifier is not known".into());
        }
        Ok(Node::Repeat { node: Box::new(atom), min, max })
    }

    fn number(&mut self) -> Result<u32, String> {
        let from = self.at;
        while self.peek().is_some_and(|c| c.is_ascii_digit()) {
            self.at += 1;
        }
        let digits: String = self.chars[from..self.at].iter().collect();
        digits.parse().map_err(|_| "the pattern has a { without a number".to_string())
    }
}

/// Whether `nodes` match from `at`, with `then` taking where they end: backtracking, greedy.
fn sequence(nodes: &[Node], at: usize, text: &[char], then: &mut dyn FnMut(usize) -> bool) -> bool {
    let Some((first, rest)) = nodes.split_first() else {
        return then(at);
    };
    match first {
        Node::Char(_) | Node::Class { .. } => {
            text.get(at).is_some_and(|&c| one(first, c)) && sequence(rest, at + 1, text, then)
        }
        Node::Start => at == 0 && sequence(rest, at, text, then),
        Node::End => at == text.len() && sequence(rest, at, text, then),
        Node::Group(alternatives) => alternatives
            .iter()
            .any(|alternative| sequence(alternative, at, text, &mut |end| sequence(rest, end, text, then))),
        Node::Repeat { node, min, max } if matches!(**node, Node::Char(_) | Node::Class { .. }) => {
            // One character at a time: as many as match, then give them back one by one.
            let limit = max.map_or(usize::MAX, |max| max as usize);
            let most = text[at..].iter().take(limit).take_while(|&&c| one(node, c)).count();
            let least = *min as usize;
            most >= least && (least..=most).rev().any(|n| sequence(rest, at + n, text, then))
        }
        Node::Repeat { node, min, max } => repeat(node, *min, *max, 0, at, rest, text, then),
    }
}

/// Whether a node of one character, a literal or a class, takes `c`.
fn one(node: &Node, c: char) -> bool {
    match node {
        Node::Char(literal) => *literal == c,
        Node::Class { ranges, negated } => ranges.iter().any(|&(low, high)| low <= c && c <= high) != *negated,
        _ => false,
    }
}

/// `node` repeated, `count` times so far, then `rest`.
#[allow(clippy::too_many_arguments)]
fn repeat(
    node: &Node,
    min: u32,
    max: Option<u32>,
    count: u32,
    at: usize,
    rest: &[Node],
    text: &[char],
    then: &mut dyn FnMut(usize) -> bool,
) -> bool {
    if max.is_none_or(|max| count < max) {
        let once = std::slice::from_ref(node);
        let more = sequence(once, at, text, &mut |end| {
            // A repetition that takes nothing ends there, as in JavaScript.
            end != at && repeat(node, min, max, count + 1, end, rest, text, then)
        });
        if more {
            return true;
        }
    }
    count >= min && sequence(rest, at, text, then)
}
