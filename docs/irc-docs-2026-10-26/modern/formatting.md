> Source: https://modern.ircdocs.horse/formatting Captured: 2026-10-26

# IRC Formatting

Daniel Oaks \[Editor\] [ircdocs](http://ircdocs.horse/) [daniel@danieloaks.net](mailto:daniel@danieloaks.net)

This document describes what I consider to be almost universally understood formatting. It is a [living specification](https://modern.ircdocs.horse/about#living-specification) which is updated in response to feedback and implementations as they change.

If I've missed out on some formatting character or method which is understood by a majority of IRC software in use today, or have made a mistake in this document, please [open an issue](https://github.com/ircdocs/modern-irc/issues) or [contact me](mailto:daniel@danieloaks.net).

---

<a id="introduction"></a>

# Introduction

IRC clients today understand a number of special formatting characters. These characters allow IRC software to send and receive colors and formatting codes such as bold, italics, underline and others.

Over the years, many clients have attempted to create their own methods of formatting and there have been variations and extensions of almost every method. However, the characters and codes described in this document are understood fairly consistently across clients today.

Following what’s described in this document should let your software send and interpret formatting in a fairly sane way, consistent with how most other IRC software out there does. Using formatting characters and methods not described in this document is possible, but it should be assumed they will not work across most clients (unless there is some way to fall back to what’s defined here).

The key words “MUST”, “MUST NOT”, “REQUIRED”, “SHALL”, “SHALL NOT”, “SHOULD”, “SHOULD NOT”, “RECOMMENDED”, “MAY”, and “OPTIONAL” in this document are to be interpreted as described in [RFC2119](http://tools.ietf.org/html/rfc2119).

---

<a id="toc"></a>

# Table of Contents

- [Formatting Uses](#formatting-uses)
  - [Messages / Numerics](#messages--numerics)
  - [Names](#names)
- [Client Behaviour](#client-behaviour)
  - [Limitations](#limitations)
  - [Preventing Display of Formatting](#preventing-display-of-formatting)
  - [ANSI Escape Code Support](#ansi-escape-code-support)
- [Characters](#characters)
  - [Bold](#bold)
  - [Italics](#italics)
  - [Underline](#underline)
  - [Strikethrough](#strikethrough)
  - [Monospace](#monospace)
  - [Color](#color)
    - [Forms of Color Codes](#forms-of-color-codes)
    - [Colors](#colors)
    - [Mistaken Eating of Text](#mistaken-eating-of-text)
    - [‘Spoilers’](#spoilers)
    - [Colors 16-98](#colors-16-98)
  - [Hex Color](#hex-color)
  - [Reverse Color](#reverse-color)
  - [Reset](#reset)
- [Examples](#examples)
- [Acknowledgements](#acknowledgements)

---

<a id="formatting-uses"></a>

# Formatting Uses

Formatting is widely used in IRC. In this section, we outline the places where formatting is traditionally used by clients and allowed by servers. This is not an expansive list nor does it note everywhere formatting is used, just some of the most common places.

<a id="messages--numerics"></a>

## Messages / Numerics

Formatting characters can be used in lots of IRC messages and numerics. This is not a complete list, just some of the messages formatting codes are used with most often.

These are some of the messages and features formatting codes are normally used with:

- [`PRIVMSG`](client-protocol.md#privmsg-message)
- [`NOTICE`](client-protocol.md#notice-message)
- [`TOPIC`](client-protocol.md#topic-message)
- [`AWAY`](client-protocol.md#away-message)
- [`USER`](client-protocol.md#user-message) (allowed in realnames, **not** in usernames)
- The [Message of the Day](client-protocol.md#motd-message)

And the numerics containing content associated with these messages and features.

<a id="names"></a>

## Names

Formatting is allowed and commonly used in realnames (set with the [`USER`](client-protocol.md#user-message) command when the client joins the network).

On some networks and with some server software, vhosts (vanity hostnames) may contain formatting characters and codes. Hostnames sent to clients MAY contain formatting, and clients SHOULD display them with this in mind.

The use of formatting MUST NOT be allowed in nicknames, user names or channel names. This is to avoid confusion and prevent issues, particularly with clients that have disabled the rendering of colors / formatting or cannot display certain types of formatting.

If a client sends a [`USER`](client-protocol.md#user-message) command with any formatting codes in the first parameter (in the username) during registration, the server SHOULD send the client an [`ERROR`](client-protocol.md#error-message) message and close the connection.

---

<a id="client-behaviour"></a>

# Client Behaviour

This section is non-normative and outlines suggested behaviour for clients and client interfaces.

<a id="limitations"></a>

## Limitations

If an IRC client cannot display a specified type of formatting, the client should do one of the following:

- Simply not display the formatting.
- Display the formatting character in an obvious way, so users are aware that it was used.

One way some clients represent formatting characters they cannot display is using an uppercase letter which represents the specific formatting character, with their default foreground and background colors switched. For example, displaying an underline formatting character as U.

<a id="preventing-display-of-formatting"></a>

## Preventing Display of Formatting

Clients may allow users to prevent all or just specified formatting from displaying. This can help users that are colorblind or are visually impaired, and should be considered by client authors.

<a id="ansi-escape-code-support"></a>

## ANSI Escape Code Support

IRC clients supporting ANSI formatting was, historically, due to clients outputting messages via terminals that supported ANSI escape codes. Many IRC clients today do not display through an interface that natively supports ANSI escape codes, and so must implement this behaviour themselves if they wish to support it.

Clients can support or not support ANSI escape codes as they like. However, they should implement this feature with the knowledge that a large number of IRC clients today, even those using a terminal interface, do not support displaying text formatted using ANSI escape codes.

---

<a id="characters"></a>

# Characters

There are a number of formatting characters that are parsed and understood by IRC software today.

Some formatting codes work as a toggle, i.e. with the first instance of the character, the specified formatting is enabled for the following text. After the next instance of that character, that formatting is disabled for the following characters. Formatting codes that work in this way are called ‘togglable’.

These formatting characters are the ones all IRC clients should understand.

<a id="bold"></a>

## Bold

```
ASCII 0x02
```

This formatting character works as a toggle. It enables bold text (e.g. **bold text**).

<a id="italics"></a>

## Italics

```
ASCII 0x1D
```

This formatting character works as a toggle. It enables italicized text (e.g. _italicised text_).

<a id="underline"></a>

## Underline

```
ASCII 0x1F
```

This formatting character works as a toggle. It enables underlined text (e.g. underlined text).

<a id="strikethrough"></a>

## Strikethrough

```
ASCII 0x1E
```

This formatting character works as a toggle. It enables strikethrough’d text (e.g. strokethrough text).

This character is a relatively new addition, and was defined by Textual. As of right now, at least HexChat, IRCCloud, Konversation, The Lounge and Textual are known to support it.

<a id="monospace"></a>

## Monospace

```
ASCII 0x11
```

This formatting character works as a toggle. It enables monospace’d text (e.g. monospace text).

This character is a relatively new addition, and was defined by IRCCloud. However, a number of other clients including TheLounge and Textual now support this as well, and it’s now the defacto formatting character for monospace text.

<a id="color"></a>

## Color

```
ASCII 0x03
```

This formatting character sets or resets colors on the following text.

With this formatting code, colors are represented as ASCII digits.

<a id="forms-of-color-codes"></a>

### Forms of Color Codes

In the following list, `<CODE>` represents the color formatting character `(0x03)`, `<COLOR>` represents one or two ASCII digits (either `0-9` or `00-99`).

The use of this code can take on the following forms:

- `<CODE>` - Reset foreground and background colors.
- `<CODE>,` - Reset foreground and background colors and display the `,` character as text.
- `<CODE><COLOR>` - Set the foreground color.
- `<CODE><COLOR>,` - Set the foreground color and display the `,` character as text.
- `<CODE><COLOR>,<COLOR>` - Set the foreground and background color.

The foreground color is the first `<COLOR>`, and the background color is the second `<COLOR>` (if sent).

If only the foreground color is set, the background color stays the same.

If there are two ASCII digits available where a \<COLOR> is allowed, then two characters MUST always be read for it and displayed as described below.

<a id="colors"></a>

### Colors

The following colors are defined for use with this formatting character:

-      - 00 - White.
-      - 01 - Black.
-      - 02 - Blue.
-      - 03 - Green.
-      - 04 - Red.
-      - 05 - Brown.
-      - 06 - Magenta.
-      - 07 - Orange.
-      - 08 - Yellow.
-      - 09 - Light Green.
-      - 10 - Cyan.
-      - 11 - Light Cyan.
-      - 12 - Light Blue.
-      - 13 - Pink.
-      - 14 - Grey.
-      - 15 - Light Grey.
-      - 99 - Default Foreground/Background - Not universally supported.

In addition, the table below describes the commonly-used colors for codes 16-98.

NOTE: The colors displayed here are simply a guide. The actual RGB values used for these codes will depend on what the client author has defined, and are often defined by the terminal color scheme for terminal-based clients.

<a id="mistaken-eating-of-text"></a>

### Mistaken Eating of Text

When sending color codes `0-9`, clients may use either the one-digit `(3)` or two-digit `(03)` versions of it. However, since two digits are always used if available, if the text following the color code starts with a digit, the last `<COLOR>` MUST use the two-digit version to be displayed correctly. This ensures that the first character of the text does not get interpreted as part of the formatting code.

If the text immediately following a code setting a foreground color consists of something like `",13"`, it will get interpreted as setting the background rather than text. In this example, clients can put the color code either after the comma character or before the character in front of the comma character to avoid this. They can also put a different formatting code after the comma to ensure that the number does not get interpreted as part of the color code (for instance, two bold characters in a row, which will cancel each other out as they are toggles).

<a id="spoilers"></a>

### ‘Spoilers’

If the background and foreground colors are the same for a section of text, on ‘hovering over’ or selecting this text these colours should be replaced with readable alternatives. For example:

this is spoilered text

<a id="colors-16-98"></a>

### Colors 16-98

When you receive the color codes 16-98, you should display them using the RGB values in this table:

16 470000

17 472100

18 474700

19 324700

20 004700

21 00472c

22 004747

23 002747

24 000047

25 2e0047

26 470047

27 47002a

28 740000

29 743a00

30 747400

31 517400

32 007400

33 007449

34 007474

35 004074

36 000074

37 4b0074

38 740074

39 740045

40 b50000

41 b56300

42 b5b500

43 7db500

44 00b500

45 00b571

46 00b5b5

47 0063b5

48 0000b5

49 7500b5

50 b500b5

51 b5006b

52 ff0000

53 ff8c00

54 ffff00

55 b2ff00

56 00ff00

57 00ffa0

58 00ffff

59 008cff

60 0000ff

61 a500ff

62 ff00ff

63 ff0098

64 ff5959

65 ffb459

66 ffff71

67 cfff60

68 6fff6f

69 65ffc9

70 6dffff

71 59b4ff

72 5959ff

73 c459ff

74 ff66ff

75 ff59bc

76 ff9c9c

77 ffd39c

78 ffff9c

79 e2ff9c

80 9cff9c

81 9cffdb

82 9cffff

83 9cd3ff

84 9c9cff

85 dc9cff

86 ff9cff

87 ff94d3

88 000000

89 131313

90 282828

91 363636

92 4d4d4d

93 656565

94 818181

95 9f9f9f

96 bcbcbc

97 e2e2e2

98 ffffff

If displaying this on an ANSI terminal, these ANSI color codes should be used:

16 52

17 94

18 100

19 58

20 22

21 29

22 23

23 24

24 17

25 54

26 53

27 89

28 88

29 130

30 142

31 64

32 28

33 35

34 30

35 25

36 18

37 91

38 90

39 125

40 124

41 166

42 184

43 106

44 34

45 49

46 37

47 33

48 19

49 129

50 127

51 161

52 196

53 208

54 226

55 154

56 46

57 86

58 51

59 75

60 21

61 171

62 201

63 198

64 203

65 215

66 227

67 191

68 83

69 122

70 87

71 111

72 63

73 177

74 207

75 205

76 217

77 223

78 229

79 193

80 157

81 158

82 159

83 153

84 147

85 183

86 219

87 212

88 16

89 233

90 235

91 237

92 239

93 241

94 244

95 247

96 250

97 254

98 231

<a id="hex-color"></a>

## Hex Color

```
ASCII 0x04
```

Some clients support an alternate form of conveying colours using hex codes.

Following this character are six hex digits representing the Red, Green and Blue values of the colour to display (e.g. `FF0000` means bright red).

Keep the [Forms of Color Codes](#forms-of-color-codes) section above in mind, as this method of formatting keeps these same rules – the exceptions being that `<CODE>` represents the hex color character `(0x04)` and `<COLOR>` represents a six-digit hex value as `RRGGBB`.

This method of formatting is not as widely-supported as the colors above, but clients are fine to parse them without any negative effects.

<a id="reverse-color"></a>

## Reverse Color

```
ASCII 0x16
```

This formatting character works as a toggle. When reverse color is enabled, the foreground and background text colors are reversed. For instance, if you enable reverse color and then send the line “C3,13Test!”, you will end up with pink foreground text and green background text while the reverse color is in effect.

This code isn’t super well-supported, and mIRC seems to always treat it as applying the reverse of the default foreground and background characters, rather than the current fore/background as set by prior mIRC color codes in the message.

<a id="reset"></a>

## Reset

```
ASCII 0x0F
```

This formatting character resets all formatting. It removes the bold, italics, and underline formatting, and sets the foreground and background colors back to the default for the client display. The text following this character will use or display no formatting, until other formatting characters are encountered.

---

<a id="examples"></a>

# Examples

In this section, the color formatting character `(0x03)` is displayed as C, the bold character `(0x02)` is displayed as B, the italics character `(0x1D)` is displayed as I, and the reset character `(0x0F)` is displayed as O.

Each example displays both the raw IRC code sent, and then a formatted version of the output.

- Code: I love C3IRC! CIt is the C7best protocol ever!

```
Output: I love IRC! It is the best protocol ever!
```

- Code: This is a IC13,9cool Cmessage

```
Output: This is a cool message
```

- Code: IRC Bis C4,12so CgreatO!

```
Output: IRC is so great!
```

- Code: Rules: Don't spam 5C13,8,6C,7,8, and especially not B9BI!

```
Output: Rules: Don't spam 5,6,7,8, and especially not 9!
```

---

<a id="acknowledgements"></a>

# Acknowledgements

Thanks to [Nei](http://anti.teamidiot.de/static/nei/*/extended_mirc_color_proposal.html) for some guidance on the extended color codes!
