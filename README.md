# astre.fits - A Simple FITS File Viewer VSCode Extension

## Project Overview

astre.fits (Astre comes from the French word for celestial body) is a VSCode extension specifically designed for viewing and analyzing FITS (Flexible Image Transport System) files, which also supports Cursor editor. Currently, it aims to provide basic FITS file parsing and visualization capabilities (including image, spectrum plotting, and table display), allowing astronomers and researchers to quickly view FITS file data directly in VSCode. The current version fulfills basic viewing requirements, with higher performance features planned for future releases. We welcome you to submit issues or contribute your solutions in our GitHub repository.

The current version is completely written and implemented using Cursor+AI models, with the author responsible for providing documentation and breaking down requirements for AI code generation and testing. Future versions will increase manual coding participation to improve the extension's performance, compatibility, and readability.

## Interface Features

When a user opens a FITS file, a window will automatically open to display the data within the FITS file. Users can freely switch between HDUs to display data. This extension supports ImageHDU, BinTableHDU, and TableHDU (ASCII tables), but currently does not support spectrum and table data in PrimaryHDU. When the FITS file contains extension HDUs, it will automatically open the data of the first extension HDU.

The current display is divided into three modes:

### Image Mode
- Mouse hover displays current position coordinates, WCS coordinates (if available), and original pixel values (Note: displayed image is normalized to 0-1 range)
- Supports non-linear transformation (based on DS9)
- Provides complete FITS header information display
- Supports switching channel (Axes) order to display DataCube order

### Spectrum Mode
- Intelligent spectrum image plotting with automatic/manual modes
- Rich interactive features:
  - Support for dragging and zooming
  - Rectangle box selection for magnification
  - Ctrl＋scroll wheel for X-axis zooming
  - Shift＋scroll wheel for Y-axis zooming
- Flexible data display:
  - Selectable wavelength/flux columns for plotting
  - Support for switching to current spectrum's table data display
  - Complete FITS header information display
- Future plans to support mask and error plotting

### Table Mode
- Clear table data display
- Support for table sorting

## Limitations

1. Performance
   - Some spectra with large jumps may have display issues during dragging
   - When switching axis order for images, current non-linear transformations may not be correctly applied
   - DataCube support is still incomplete, with issues in header parsing and axis selection convenience
   - Potentially incomplete temporary file cleanup mechanism
   - Large files may load slowly, such as HST wide-field images which are slow to load and difficult to drag (limited by Web interface constraints)
   - Loading and parsing large FITS files may consume significant memory
   - Rendering complex table data may have performance bottlenecks

2. Compatibility
   - Some FITS extension formats may not be supported (in progress)
   - Compressed FITS formats are not supported
   - Known issues with HST COS spectra table display

## Installation and Usage

1. Search for "Astre Fits" in VSCode Extension Marketplace
2. Click install
3. After installation, you can directly open .fits or .fit files
4. The extension will automatically activate and display file content

## References

1. Definition of the Flexible Image Transport System (FITS) Version 4.0
2. SAOImageDS9: https://ds9.si.edu/doc/ref/how.html

## Contribution Guidelines

Welcome to submit issue reports and feature suggestions to the project's GitHub repository.

## Acknowledgments

Version 1.0.0 of this project was completely developed using Cursor and its supported AI models including Claude 3.5 Sonet (primary), Claude 3.7 Sonet, Deepseek R1, and O3 mini. The author was responsible for supervision and testing, and properly used FITS definitions to constrain code writing. This development approach greatly improved development efficiency while ensuring code quality.

## Contact

renhaoye@shao.ac.cn

## License

This project follows the GPL3.0 License.