# Astre FITS - FITS File Viewer VSCode Extension

## Project Overview

Astre FITS (Astre comes from the French word for celestial body) is a VSCode extension specifically designed for viewing and analyzing FITS (Flexible Image Transport System) files, which also supports Cursor and Trae editors. It provides basic FITS file parsing and visualization capabilities (including image, spectrum plotting, and table display), allowing astronomers and researchers to conveniently view and analyze FITS file data directly in VSCode. The current version fulfills basic requirements, with higher performance features planned for future releases. We welcome you to submit issues or contribute your solutions in our GitHub repository.

## Interface Features

When a user opens a FITS file, a window will automatically open to display the data within the FITS file. Users can freely switch between HDUs to display data. This extension supports ImageHDU, BinTableHDU, and TableHDU (ASCII tables), but currently does not support spectrum and table data in PrimaryHDU. When the FITS file contains extension HDUs, it will automatically open the data of the first extension HDU.

The current display is divided into three modes:

### Image Mode
- Mouse hover displays current position coordinates, WCS coordinates (if available), and original pixel values (Note: displayed image is normalized to 0-1 range)
- Supports non-linear transformation
- Provides complete FITS header information display
- Supports switching channel (Axes) order to display DataCube order

### Spectrum Mode
- Intelligent spectrum image plotting with automatic/manual modes
- Rich interactive features:
  - Support for dragging and zooming
  - Rectangle box selection for local magnification
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

## Technical Implementation

### Core Modules

1. FITSParser
   - Responsible for low-level FITS file parsing
   - Implements complete FITS standard specifications

2. FITSViewerProvider
   - Provides VSCode custom editor support
   - Implements FITS file visualization
   - Handles user interaction and interface updates

3. Data Models
   - FITSHeader: Handles file header information
   - FITSHDU: Manages header data units
   - TableData: Processes table data
   - ColumnData: Manages column data

## Limitations

1. Performance Limitations
   - Large files may load slowly, large images like HST wide-field images load slowly and are difficult to drag, limited by inherent Web interface constraints
   - Loading and parsing large FITS files may consume significant memory
   - Rendering complex table data may have performance bottlenecks

2. Data Compatibility
   - Some special FITS extension formats may not be supported
   - Compression formats not tested
   - Some non-standard FITS files may not parse correctly, known issues with HST cos spectra table display

## Future Improvement Plans

1. Performance Optimization
   - Optimize large file processing mechanisms
   - Improve caching mechanisms

2. Feature Extensions
   - Add data analysis tools
   - Add more data visualization options

3. User Experience
   - Improve error notification mechanisms
   - Add more user configuration options
   - Optimize interface interaction design

## Development Requirements

- VSCode 1.97.0 or higher
- Node.js
- TypeScript

## Installation and Usage

1. Search for "Astre Fits" in VSCode Extension Marketplace
2. Click install
3. After installation, you can directly open .fits or .fit files
4. The extension will automatically activate and display file content

## References

1. Definition of the Flexible Image Transport System (FITS) Version 4.0
2. SAOImageDS9

## Contribution Guidelines

Welcome to submit issue reports and feature suggestions to the project's GitHub repository. If you want to contribute code, please ensure:

1. Follow the project's code standards
2. Write necessary test cases
3. Submit detailed PR descriptions

## Acknowledgments

Version 1.0.0 of this project was developed from scratch using Cursor and its supported AI models including Claude 3.5 Sonet (primary), Claude 3.7 Sonet, Deepseek R1, and O3 mini. The author was responsible for supervision and testing, and properly used FITS definitions to constrain code writing. This development approach greatly improved development efficiency while ensuring code quality.

## License

This project follows the MIT License.