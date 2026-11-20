/**
 * The mark of a bot: a dim `bot`, small, beside a nick that its User said is one. It is the
 * word itself, so a screen reader hears it, and a copy of the text leaves it out.
 *
 * @packageDocumentation
 */
import styles from "./bot-mark.module.css";

/**
 * The mark of a bot.
 * @returns The mark.
 */
export const BotMark = () => <span className={styles.mark}>bot</span>;
