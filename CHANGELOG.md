# Change Log

All notable changes to this extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.1]

-   Fixed an issue where a test will be stuck in waiting if a Before/After hook gave an exception [Thanks to orine]
-   Fixed an issue where the runner tried to output errors even if the Before/After hook completed successfully [Thanks to orine]
-   Now skipped tests should be correctly marked as Skipped in the Test Runner UI [Thanks to orine]

## [0.5.0]

-   Added support for tags filtering in the test runner tree [Thanks to psethwick]
-   Added a new setting "cucumberTestRunner.env" to allow the users to specify custom environment variables to run the tests [Thanks to hardymj]
-   Added a new setting "cucumberTestRunner.profile" to allow the users to select a cucumber-js profile to run the tests
-   Added initial support for error detection in before and after hooks

## [0.4.1]

-   Added support for Scenarios under Rules
-   Deleted/Renamed feature files now update correctly
-   Updated README with Known Issues

## [0.4.0]

-   Rewritten test runner for better stability
-   Now single steps are marked as not runnable
-   Better error reporting when a step fails

## [0.3.0]

-   Added support for gherkin context actions
-   Improved parsing of cucumber CLI output
-   Now you can display colored output from libraries like React Testing Library
-   Removed play and debug buttons from steps
-   Better error handling

## [0.2.1]

-   Fixed a small parser bug that prevented multi-line error to display properly

## [0.2.0]

-   Changed cucumber CLI parser to JSON format

## [0.1.0]

-   Initial release
